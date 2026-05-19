/**
 * Regression tests for the thin-signal floor in SkillEngine.detectTechStack (issue #410).
 *
 * When a host project has fewer than TECH_STACK_MIN_DEPS (3) distinct dependencies
 * across all collected package.json entries, detectTechStack must return null without
 * calling the LLM. The caller (buildPrompt) must then omit the <tech_stack> block
 * from the user prompt entirely.
 *
 * Three fixtures:
 *   A — 1-dep audit-team repro: LLM NOT called for tech-stack, <tech_stack> absent.
 *   B — 3-dep boundary (threshold met): LLM IS called, <tech_stack> present.
 *   C — 2-dep boundary (threshold not met): LLM NOT called, <tech_stack> absent.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillEngine, ILLMProvider, PerformanceReader } from '@gossip/orchestrator';

const VALID_SKILL = `---
name: injection-audit
category: injection_vectors
agent: agent-a
generated: 2026-03-28T00:00:00Z
effectiveness: 0.0
baseline_rate: 0.0
baseline_dispatches: 0
post_skill_dispatches: 0
version: 1
mode: contextual
keywords: [injection, xss, sql, sanitize]
---

# Injection Audit

## Iron Law

NEVER assess injection risk without tracing the full input path.

## When This Skill Activates

- Task mentions injection, sanitization, prompt construction

## Methodology

1. Map all entry points
2. Trace each input path
3. Check sanitization at boundaries
4. Review escaping at output boundaries
5. Verify parameterization

## Key Patterns

- Check for raw string interpolation in LLM prompts

## Anti-Patterns

- **"It's wrapped in tags"** — Tags are advisory, not sanitization boundaries

## Quality Gate

- [ ] Each finding cites file:line
`;

/**
 * Create a mock ILLMProvider.
 *
 * The mock distinguishes tech-stack calls (temperature 0) from skill-gen
 * calls (temperature 0.3) so tests can assert independently on each.
 *
 * - techStackResponse: returned when called with temperature 0 (detectTechStack).
 *   Pass null to throw (simulating LLM not supposed to be called).
 * - skillGenResponse: returned when called with temperature 0.3 (generate).
 */
function makeLLMMock(opts: {
  techStackResponse: string | null;
  skillGenResponse: string;
}): { llm: ILLMProvider; techStackCallCount: () => number; skillGenCallCount: () => number } {
  let techStackCalls = 0;
  let skillGenCalls = 0;

  const llm: ILLMProvider = {
    generate: jest.fn((_messages, options) => {
      const temp = options?.temperature ?? 0.3;
      if (temp === 0) {
        // tech-stack detection call
        techStackCalls++;
        if (opts.techStackResponse === null) {
          throw new Error('LLM must NOT be called for tech-stack detection in this fixture');
        }
        return Promise.resolve({ text: opts.techStackResponse });
      } else {
        // skill generation call
        skillGenCalls++;
        return Promise.resolve({ text: opts.skillGenResponse });
      }
    }),
  };

  return {
    llm,
    techStackCallCount: () => techStackCalls,
    skillGenCallCount: () => skillGenCalls,
  };
}

function makeStubReader(projectRoot: string): PerformanceReader {
  const reader = new PerformanceReader(projectRoot);
  jest.spyOn(reader, 'getCountersSince').mockReturnValue({ correct: 0, hallucinated: 0 });
  jest.spyOn(reader, 'getScores').mockReturnValue(new Map());
  return reader;
}

function setupProjectRoot(pkg: object, extraFiles?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-tech-stack-'));
  mkdirSync(join(dir, '.gossip'), { recursive: true });
  writeFileSync(join(dir, '.gossip', 'bootstrap.md'), '# Test Project\n');
  writeFileSync(join(dir, '.gossip', 'agent-performance.jsonl'), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  if (extraFiles) {
    for (const [relPath, content] of Object.entries(extraFiles)) {
      const fullPath = join(dir, relPath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }
  return dir;
}

describe('SkillEngine.detectTechStack — thin-signal floor (issue #410)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Fixture A — audit-team repro: 1 dep + .sol files.
   *
   * A project with only { "gossipcat": "*" } in dependencies must not trigger
   * the tech-stack LLM call. The system prompt must not contain <tech_stack>.
   */
  test('Fixture A: 1-dep project — LLM not called for tech-stack, <tech_stack> absent', async () => {
    const projectRoot = setupProjectRoot(
      { dependencies: { gossipcat: '*' } },
      {
        'Token.sol': 'pragma solidity ^0.8.0;\ncontract Token {}\n',
        'Vault.sol': 'pragma solidity ^0.8.0;\ncontract Vault {}\n',
        'Staking.sol': 'pragma solidity ^0.8.0;\ncontract Staking {}\n',
      },
    );

    try {
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: null, // must NOT be called
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);
      const promptData = await engine.buildPrompt('agent-a', 'injection_vectors');

      expect(techStackCallCount()).toBe(0);
      // The static requirements text always has the literal "(see <tech_stack>)" — we check
      // that the injected block is absent from project_context. The injection produces
      // "\n\n<tech_stack>\n...\n</tech_stack>" inside <project_context>.
      expect(promptData.user).not.toMatch(/<tech_stack>\n/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Fixture B — 3-dep boundary: threshold exactly met.
   *
   * A project with express, pg, zod (3 deps) must trigger the tech-stack
   * LLM call exactly once, and the user prompt must contain the <tech_stack>
   * block with the canned response content.
   */
  test('Fixture B: 3-dep project — LLM called once for tech-stack, <tech_stack> present', async () => {
    const projectRoot = setupProjectRoot({
      dependencies: { express: '^4.18.0', pg: '^8.11.0', zod: '^3.22.0' },
    });

    try {
      const cannedResponse = 'TypeScript + Node.js / Express API with PostgreSQL. No HTML rendering. No GraphQL.';
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: cannedResponse,
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);
      const promptData = await engine.buildPrompt('agent-a', 'injection_vectors');

      expect(techStackCallCount()).toBe(1);
      // The injected block: "\n\n<tech_stack>\n{content}\n</tech_stack>"
      expect(promptData.user).toMatch(/<tech_stack>\n/);
      expect(promptData.user).toContain(cannedResponse);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Fixture B (memoization) — same 3-dep setup called twice via buildPrompt.
   *
   * Tech-stack detection runs during buildPrompt. Calling buildPrompt a second
   * time on the same engine instance must NOT trigger a second LLM call for
   * tech-stack — the result must be served from the internal cache.
   */
  it('Fixture B: memoizes tech-stack detection across buildPrompt calls', async () => {
    const projectRoot = setupProjectRoot({
      dependencies: { express: '^4.18.0', pg: '^8.11.0', zod: '^3.22.0' },
    });

    try {
      const cannedResponse = 'TypeScript + Node.js / Express API with PostgreSQL. No HTML rendering. No GraphQL.';
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: cannedResponse,
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);

      // First call — cache cold, tech-stack LLM should be called once
      await engine.buildPrompt('agent-a', 'injection_vectors');
      // Second call — cache warm, tech-stack LLM must NOT be called again
      await engine.buildPrompt('agent-a', 'injection_vectors');

      expect(techStackCallCount()).toBe(1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Fixture C — 2-dep boundary: threshold not met.
   *
   * A project with gossipcat + typescript (2 deps) must NOT trigger the
   * tech-stack LLM call, and the injected <tech_stack> block must be absent.
   */
  test('Fixture C: 2-dep project — LLM not called for tech-stack, <tech_stack> absent', async () => {
    const projectRoot = setupProjectRoot({
      dependencies: { gossipcat: '*' },
      devDependencies: { typescript: '^5.0.0' },
    });

    try {
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: null, // must NOT be called
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);
      const promptData = await engine.buildPrompt('agent-a', 'injection_vectors');

      expect(techStackCallCount()).toBe(0);
      expect(promptData.user).not.toMatch(/<tech_stack>\n/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('SkillEngine.readTechStackOverride — Option C user override (issue #410)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Fixture D — Override wins over auto-detect.
   *
   * .gossip/tech-stack.md present + thin-signal package.json (1 dep, would NOT
   * trigger LLM via auto-detect). Override content should appear in <tech_stack>
   * block; LLM must NOT be called for tech-stack detection.
   */
  it('Fixture D: override wins over auto-detect — LLM not called, override text in prompt', async () => {
    const overrideContent = 'Solidity + Foundry. No Node.js runtime. No SQL database.';
    const projectRoot = setupProjectRoot(
      { dependencies: { gossipcat: '*' } },
      { '.gossip/tech-stack.md': overrideContent },
    );

    try {
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: null, // must NOT be called
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);
      const promptData = await engine.buildPrompt('agent-a', 'injection_vectors');

      expect(techStackCallCount()).toBe(0);
      expect(promptData.user).toMatch(/<tech_stack>\n/);
      expect(promptData.user).toContain(overrideContent);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Fixture E — Override beats rich auto-detect signal.
   *
   * Same override file, but package.json with 5+ deps (would normally fire
   * auto-detect). Override must still win; LLM not called for tech-stack.
   */
  it('Fixture E: override beats rich auto-detect signal — LLM not called, override text in prompt', async () => {
    const overrideContent = 'Solidity + Foundry. No Node.js runtime. No SQL database.';
    const projectRoot = setupProjectRoot(
      {
        dependencies: {
          express: '^4.18.0',
          pg: '^8.11.0',
          zod: '^3.22.0',
          lodash: '^4.17.21',
          axios: '^1.6.0',
        },
      },
      { '.gossip/tech-stack.md': overrideContent },
    );

    try {
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: null, // must NOT be called
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);
      const promptData = await engine.buildPrompt('agent-a', 'injection_vectors');

      expect(techStackCallCount()).toBe(0);
      expect(promptData.user).toMatch(/<tech_stack>\n/);
      expect(promptData.user).toContain(overrideContent);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Fixture F — Override > 2KB is clamped to first 2000 chars.
   *
   * Write a 3KB override file. Assert system prompt contains exactly the first
   * 2000 chars. Spy on process.stderr.write and assert a clamping warning was
   * emitted once.
   */
  it('Fixture F: override > 2KB is clamped — first 2000 chars in prompt, stderr warning', async () => {
    // 'A' repeated to build a 3072-byte file (3KB)
    const longContent = 'A'.repeat(3072);
    const projectRoot = setupProjectRoot(
      { dependencies: { gossipcat: '*' } },
      { '.gossip/tech-stack.md': longContent },
    );

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: null, // must NOT be called for tech-stack
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);
      const promptData = await engine.buildPrompt('agent-a', 'injection_vectors');

      // LLM should not be called for tech-stack — override wins
      expect(techStackCallCount()).toBe(0);

      // The injected text should be exactly the first 2000 chars (trim doesn't change 'A' * 2000)
      const expectedClamp = 'A'.repeat(2000);
      expect(promptData.user).toContain(expectedClamp);
      // Must not contain chars beyond the clamp boundary
      expect(promptData.user).not.toContain('A'.repeat(2001));

      // Stderr warning emitted exactly once about clamping
      const clampWarnings = (stderrSpy.mock.calls as unknown[][])
        .map(args => String(args[0]))
        .filter(s => s.includes('clamping to 2000 chars'));
      expect(clampWarnings).toHaveLength(1);
    } finally {
      stderrSpy.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Fixture G — Override read error falls through to auto-detect.
   *
   * Create a *directory* named .gossip/tech-stack.md so existsSync returns true
   * but readFileSync throws EISDIR. Assert:
   * - Falls through to auto-detect (LLM is called when dep floor passes)
   * - process.stderr.write spy invoked with read-failed warning
   */
  it('Fixture G: override read error falls through to auto-detect, stderr warning emitted', async () => {
    // 5-dep project so auto-detect floor (TECH_STACK_MIN_DEPS=3) is met
    const projectRoot = setupProjectRoot({
      dependencies: {
        express: '^4.18.0',
        pg: '^8.11.0',
        zod: '^3.22.0',
        lodash: '^4.17.21',
        axios: '^1.6.0',
      },
    });
    // Create a DIRECTORY at the override path — existsSync returns true, readFileSync throws EISDIR
    mkdirSync(join(projectRoot, '.gossip', 'tech-stack.md'), { recursive: true });

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const cannedAutoDetect = 'TypeScript + Node.js / Express API.';
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: cannedAutoDetect,
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);
      await engine.buildPrompt('agent-a', 'injection_vectors');

      // Falls through: LLM IS called for tech-stack (auto-detect)
      expect(techStackCallCount()).toBe(1);

      // Stderr warning emitted about read failure
      const errorWarnings = (stderrSpy.mock.calls as unknown[][])
        .map(args => String(args[0]))
        .filter(s => s.includes('tech-stack.md override read failed'));
      expect(errorWarnings).toHaveLength(1);
    } finally {
      stderrSpy.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Fixture H — Empty override file falls through to auto-detect silently.
   *
   * Write an empty (or whitespace-only) .gossip/tech-stack.md. Assert:
   * - Falls through to auto-detect (LLM called if floor passes)
   * - No stderr warning emitted (empty file is a silent no-op)
   */
  it('Fixture H: empty override file falls through to auto-detect, no stderr warning', async () => {
    // 5-dep project so auto-detect floor is met
    const projectRoot = setupProjectRoot(
      {
        dependencies: {
          express: '^4.18.0',
          pg: '^8.11.0',
          zod: '^3.22.0',
          lodash: '^4.17.21',
          axios: '^1.6.0',
        },
      },
      { '.gossip/tech-stack.md': '   \n  \n  ' }, // whitespace-only
    );

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const cannedAutoDetect = 'TypeScript + Node.js / Express API.';
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: cannedAutoDetect,
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);
      await engine.buildPrompt('agent-a', 'injection_vectors');

      // Falls through: LLM IS called for tech-stack
      expect(techStackCallCount()).toBe(1);

      // No stderr warning for empty file
      const overrideWarnings = (stderrSpy.mock.calls as unknown[][])
        .map(args => String(args[0]))
        .filter(s => s.includes('tech-stack.md'));
      expect(overrideWarnings).toHaveLength(0);
    } finally {
      stderrSpy.mockRestore();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Memoization — override content is served from cache on second buildPrompt call.
   *
   * With the override file present, two buildPrompt calls on the same engine
   * instance must both contain the override text, and the LLM must never be
   * called for tech-stack (proving techStackCache is populated from the first
   * call and reused on the second without re-reading the file).
   */
  it('Memoization: override result is cached — LLM not called on second buildPrompt', async () => {
    const overrideContent = 'Rust + Axum. No Node.js. No SQL.';
    const projectRoot = setupProjectRoot(
      { dependencies: { gossipcat: '*' } },
      { '.gossip/tech-stack.md': overrideContent },
    );

    try {
      const { llm, techStackCallCount } = makeLLMMock({
        techStackResponse: null, // must NOT be called for tech-stack
        skillGenResponse: VALID_SKILL,
      });

      const engine = new SkillEngine(llm, makeStubReader(projectRoot), projectRoot);

      // First call — cold cache, override read
      const prompt1 = await engine.buildPrompt('agent-a', 'injection_vectors');
      // Second call — warm cache, must not re-read or call auto-detect
      const prompt2 = await engine.buildPrompt('agent-a', 'injection_vectors');

      // Both calls produce the override content in the prompt
      expect(prompt1.user).toContain(overrideContent);
      expect(prompt2.user).toContain(overrideContent);

      // LLM never called for tech-stack across both calls (cache hit on second)
      expect(techStackCallCount()).toBe(0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
