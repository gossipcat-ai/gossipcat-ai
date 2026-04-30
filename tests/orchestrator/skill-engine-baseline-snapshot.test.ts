import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillEngine } from '../../packages/orchestrator/src/skill-engine';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';

/** Minimal valid skill file the stub LLM returns */
const STUB_SKILL = `---
name: trust-boundaries
category: trust_boundaries
agent: test-agent
generated: 2026-01-01T00:00:00.000Z
effectiveness: 0.0
baseline_rate: 0.000
baseline_dispatches: 0
post_skill_dispatches: 0
version: 1
mode: contextual
keywords: [auth, authentication, authorization, session, cookie, token, path, traversal, injection, middleware, permission, role, privilege, acl]
---

## Iron Law

NEVER trust data from outside the process boundary without explicit validation.

## When This Skill Activates

- Authentication or authorization code paths
- Session/token management
- Path construction with user input

## Methodology

1. Identify all external data entry points in the code under review
2. Trace each entry point to its consumers
3. Check for validation before trust decisions
4. Verify privilege escalation paths are guarded
5. Confirm session fixation mitigations exist

## Key Patterns

- Missing auth checks on API routes
- Unvalidated path segments concatenated with os.path.join
- Token reuse without expiry checks

## Anti-Patterns

- **"The framework handles it"** — Verify framework defaults; many require explicit opt-in.
- **"We validate at the boundary"** — Multi-layer trust decisions still need per-layer checks.

## Quality Gate

- [ ] All external data entry points identified
- [ ] Validation present before trust decisions
- [ ] No implicit trust of caller-supplied roles
`;

function makeStubLLM(): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text: STUB_SKILL }),
  } as unknown as ILLMProvider;
}

function makeStubPerfReader(
  projectRoot: string,
  categoryCorrect: Record<string, number>,
  categoryHallucinated: Record<string, number>,
): PerformanceReader {
  const reader = new PerformanceReader(projectRoot);
  jest.spyOn(reader, 'getCountersSince').mockImplementation((_a, cat) => ({
    correct: categoryCorrect[cat] ?? 0,
    hallucinated: categoryHallucinated[cat] ?? 0,
  }));
  jest.spyOn(reader, 'getScores').mockReturnValue(
    new Map([
      [
        'test-agent',
        {
          agentId: 'test-agent',
          accuracy: 0,
          uniqueness: 0,
          reliability: 0,
          impactScore: 0,
          totalSignals: 0,
          agreements: 0,
          disagreements: 0,
          uniqueFindings: 0,
          hallucinations: 0,
          weightedHallucinations: 0,
          consecutiveFailures: 0,
          circuitOpen: false,
          categoryStrengths: {},
          categoryAccuracy: {},
          categoryCorrect,
          categoryHallucinated,
          transport_failure_count: 0,
        },
      ],
    ]),
  );
  return reader;
}

describe('SkillEngine — baseline snapshot in frontmatter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-gen-test-'));
  });

  it('writes baseline_correct and baseline_hallucinated from PerformanceReader counters', async () => {
    const llm = makeStubLLM();
    const perfReader = makeStubPerfReader(tmpDir, { trust_boundaries: 42 }, { trust_boundaries: 8 });
    const gen = new SkillEngine(llm, perfReader, tmpDir);

    const result = await gen.generate('test-agent', 'trust_boundaries');

    const written = readFileSync(result.path, 'utf-8');
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).toBeTruthy(); // file must have YAML frontmatter

    const fm = fmMatch![1];
    expect(fm).toMatch(/baseline_accuracy_correct:\s*42/);
    expect(fm).toMatch(/baseline_accuracy_hallucinated:\s*8/);
  });

  it('writes bound_at as a valid ISO 8601 timestamp', async () => {
    const before = new Date();
    const llm = makeStubLLM();
    const perfReader = makeStubPerfReader(tmpDir, { trust_boundaries: 5 }, { trust_boundaries: 1 });
    const gen = new SkillEngine(llm, perfReader, tmpDir);

    const result = await gen.generate('test-agent', 'trust_boundaries');
    const after = new Date();

    const written = readFileSync(result.path, 'utf-8');
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch![1];

    const boundAtMatch = fm.match(/bound_at:\s*(.+)/);
    expect(boundAtMatch).toBeTruthy(); // bound_at must be present in frontmatter
    const ts = new Date(boundAtMatch![1].trim());
    expect(isNaN(ts.getTime())).toBe(false); // bound_at must be a parseable date
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('writes migration_count: 0 as a number', async () => {
    const llm = makeStubLLM();
    const perfReader = makeStubPerfReader(tmpDir, {}, {});
    const gen = new SkillEngine(llm, perfReader, tmpDir);

    const result = await gen.generate('test-agent', 'trust_boundaries');

    const written = readFileSync(result.path, 'utf-8');
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch![1];
    // Must be "migration_count: 0" not "migration_count: '0'"
    expect(fm).toMatch(/migration_count:\s*0\b/);
    expect(fm).not.toMatch(/migration_count:\s*['"]0['"]/);
  });

  it('writes status: pending', async () => {
    const llm = makeStubLLM();
    const perfReader = makeStubPerfReader(tmpDir, {}, {});
    const gen = new SkillEngine(llm, perfReader, tmpDir);

    const result = await gen.generate('test-agent', 'trust_boundaries');

    const written = readFileSync(result.path, 'utf-8');
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch![1];
    expect(fm).toMatch(/status:\s*pending/);
  });

  it('preserves bound_at when redeveloping a pending skill (regression: #147)', async () => {
    const llm = makeStubLLM();
    const perfReader = makeStubPerfReader(tmpDir, { trust_boundaries: 3 }, { trust_boundaries: 1 });
    const gen = new SkillEngine(llm, perfReader, tmpDir);

    // First bind — records initial bound_at
    const first = await gen.generate('test-agent', 'trust_boundaries');
    const firstFm = readFileSync(first.path, 'utf-8').match(/^---\n([\s\S]*?)\n---/)![1];
    const firstBoundAt = firstFm.match(/bound_at:\s*(.+)/)![1].trim();

    // Small delay so any new timestamp would differ from the first
    await new Promise((r) => setTimeout(r, 10));

    // Re-develop — skill is still pending (status was written as pending)
    const second = await gen.generate('test-agent', 'trust_boundaries');
    const secondFm = readFileSync(second.path, 'utf-8').match(/^---\n([\s\S]*?)\n---/)![1];
    const secondBoundAt = secondFm.match(/bound_at:\s*(.+)/)![1].trim();

    expect(secondBoundAt).toBe(firstBoundAt); // bound_at MUST be preserved for pending redevelop
  });

  it('mints a fresh bound_at when there is no existing skill file (first bind)', async () => {
    const llm = makeStubLLM();
    const perfReader = makeStubPerfReader(tmpDir, {}, {});
    const gen = new SkillEngine(llm, perfReader, tmpDir);

    const before = Date.now();
    const result = await gen.generate('test-agent', 'trust_boundaries');
    const fm = readFileSync(result.path, 'utf-8').match(/^---\n([\s\S]*?)\n---/)![1];
    const boundAtTs = new Date(fm.match(/bound_at:\s*(.+)/)![1].trim()).getTime();

    expect(boundAtTs).toBeGreaterThanOrEqual(before);
  });

  it('writes effectiveness: 0.0 (number, not string)', async () => {
    const llm = makeStubLLM();
    const perfReader = makeStubPerfReader(tmpDir, {}, {});
    const gen = new SkillEngine(llm, perfReader, tmpDir);

    const result = await gen.generate('test-agent', 'trust_boundaries');

    const written = readFileSync(result.path, 'utf-8');
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch![1];
    expect(fm).toMatch(/effectiveness:\s*0(?:\.0)?/);
    expect(fm).not.toMatch(/effectiveness:\s*['"]0/);
  });

  it('defaults to 0 when the agent has no counter data for the category', async () => {
    const llm = makeStubLLM();
    // Agent exists but has no trust_boundaries entries
    const perfReader = makeStubPerfReader(tmpDir, { injection_vectors: 10 }, { injection_vectors: 2 });
    const gen = new SkillEngine(llm, perfReader, tmpDir);

    const result = await gen.generate('test-agent', 'trust_boundaries');

    const written = readFileSync(result.path, 'utf-8');
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch![1];
    expect(fm).toMatch(/baseline_accuracy_correct:\s*0\b/);
    expect(fm).toMatch(/baseline_accuracy_hallucinated:\s*0\b/);
  });

  it('defaults to 0 when the agent is not in the scores map at all', async () => {
    const llm = makeStubLLM();
    const reader = new PerformanceReader(tmpDir);
    jest.spyOn(reader, 'getScores').mockReturnValue(new Map()); // empty — agent unknown
    const gen = new SkillEngine(llm, reader, tmpDir);

    const result = await gen.generate('test-agent', 'trust_boundaries');

    const written = readFileSync(result.path, 'utf-8');
    const fmMatch = written.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch![1];
    expect(fm).toMatch(/baseline_accuracy_correct:\s*0\b/);
    expect(fm).toMatch(/baseline_accuracy_hallucinated:\s*0\b/);
  });
});
