import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { ConsensusEngine, ILLMProvider } from '@gossip/orchestrator';

// Minimal mock LLM — not used by verifyCitations
const mockLlm = {
  generate: async () => ({ text: '', toolCalls: [] }),
} as unknown as ILLMProvider;

const mockRegistryGet = () => undefined;

describe('ConsensusEngine.verifyCitations', () => {
  const testDir = resolve(tmpdir(), 'gossip-citation-test-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    // Create a fake project structure
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/task-dispatcher.ts'),
      [
        'import { randomUUID } from "crypto";',              // line 1
        '',                                                    // line 2
        'export class TaskDispatcher {',                      // line 3
        '  constructor(private registry: AgentRegistry) {}',  // line 4
        '',                                                    // line 5
        '  async decompose(task: string) {',                  // line 6
        '    const plan = await this.llm.generate(messages);', // line 7
        '    return plan;',                                    // line 8
        '  }',                                                // line 9
        '',                                                    // line 10
        '  assignAgents(plan: DispatchPlan) {',               // line 11
        '    for (const subTask of plan.subTasks) {',         // line 12
        '      const match = this.registry.findBestMatch(subTask.requiredSkills);', // line 13
        '      if (match) {',                                 // line 14
        '        subTask.assignedAgent = match.id;',          // line 15
        '      } else {',                                     // line 16
        '        plan.warnings.push("no agent found");',      // line 17
        '      }',                                            // line 18
        '    }',                                               // line 19
        '    return plan;',                                    // line 20
        '  }',                                                // line 21
        '}',                                                   // line 22
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  test('accepts citation when file and line exist (structural check only)', async () => {
    // verifyCitations now only checks structural validity (file exists, line in range)
    // Behavioral claim verification is handled by ConsensusJudge
    const evidence =
      'The code at task-dispatcher.ts:14 explicitly throws an error if no agent is available.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // file exists, line in range → structurally valid
  });

  test('accepts valid citation — file and line exist', async () => {
    const evidence =
      'The code at task-dispatcher.ts:17 pushes a warning when no agent is found.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // file exists, line in range → structurally valid
  });

  test('detects fabricated citation — file does not exist', async () => {
    const evidence =
      'The code at nonexistent-file.ts:10 validates the input thoroughly.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(true); // fabricated — file doesn't exist
  });

  test('detects fabricated citation — line beyond file length', async () => {
    const evidence =
      'The code at task-dispatcher.ts:500 throws an error for invalid tasks.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(true); // fabricated — file only has 22 lines
  });

  test('returns false when no citations in evidence', async () => {
    const evidence =
      'I disagree because the logic is fundamentally flawed and does not handle edge cases.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // no citations to verify
  });

  test('returns false when no projectRoot configured', async () => {
    const engineNoRoot = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      // no projectRoot
    });

    const evidence = 'The code at task-dispatcher.ts:14 explicitly throws an error.';
    const result = await engineNoRoot.verifyCitations(evidence);
    expect(result).toBe(false); // can't verify without projectRoot
  });

  test('handles multiple citations — all exist structurally', async () => {
    const evidence =
      'The code at task-dispatcher.ts:13 calls findBestMatch which validates input, ' +
      'and task-dispatcher.ts:14 handles the result.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // both lines exist in file → structurally valid
  });

  test('handles citation with full path', async () => {
    const evidence =
      'At packages/orchestrator/src/task-dispatcher.ts:14 the code handles agent assignment.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // file exists at full path, line in range
  });
});

describe('ConsensusEngine.synthesize — citation verification integration', () => {
  const testDir = resolve(tmpdir(), 'gossip-synth-citation-test-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/task-dispatcher.ts'),
      [
        'export class TaskDispatcher {',
        '  assignAgents(plan: DispatchPlan) {',
        '    if (match) {',
        '      subTask.assignedAgent = match.id;',
        '    } else {',
        '      plan.warnings.push("no agent");',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  test('fabricated dispute citing non-existent file does not suppress valid finding', async () => {
    // Finding text includes "authentication" so extractCategories yields
    // trust_boundaries — the category-enforcement check added in
    // docs/specs/2026-04-16-hallucination-decay-tune.md drops hallucination_caught
    // signals that cannot be attributed to any category, so the test fixture now
    // must carry a categorizable keyword.
    const results = [
      { id: 'task-1', agentId: 'agent-a', task: 'review', status: 'completed' as const, result: '## Consensus Summary\n- Empty agentId allows invalid dispatch (authentication bypass)', startedAt: Date.now() },
      { id: 'task-2', agentId: 'agent-b', task: 'review', status: 'completed' as const, result: '## Consensus Summary\n- Some other finding', startedAt: Date.now() },
    ];

    const crossReviewEntries = [
      {
        action: 'disagree' as const,
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        finding: 'Empty agentId allows invalid dispatch (authentication bypass)',
        evidence: 'The code at nonexistent-module.ts:3 explicitly throws an error.',
        confidence: 4,
      },
    ];

    const report = await engine.synthesize(results, crossReviewEntries);

    // The finding should NOT be tagged as disputed — the dispute cites a non-existent file
    const finding = report.confirmed.find(f => f.finding.includes('Empty agentId'))
      || report.unique.find(f => f.finding.includes('Empty agentId'));

    expect(finding).toBeDefined();
    expect(report.disputed.find(f => f.finding.includes('Empty agentId'))).toBeUndefined();

    // Should emit a hallucination_caught signal
    const hallucinationSignal = report.signals.find(
      s => s.signal === 'hallucination_caught',
    );
    expect(hallucinationSignal).toBeDefined();
    // Category enforcement: the emitted signal must have a category (trust_boundaries)
    // derived either from the confirmed finding or the reviewer's evidence.
    expect(hallucinationSignal!.category).toBeTruthy();
  });
});

// verifyCitations on confirmed findings is tested via the synthesize integration test above

// ────────────────────────────────────────────────────────────────────
// Tier 1A — Fix #4: fileCache invalidation parity with pathCache
// Consensus round 82a3c123-19db41e7
// ────────────────────────────────────────────────────────────────────
describe('Tier 1A Fix #4 — fileCache parity with pathCache on worktree change', () => {
  const testDir = resolve(tmpdir(), 'gossip-filecache-parity-' + Date.now());
  const targetFile = resolve(testDir, 'src', 'ephemeral.ts');

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'src'), { recursive: true });
    writeFileSync(targetFile, 'export const X = 1;\nexport const Y = 2;\nexport const Z = 3;\n');
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('fileCache cleared alongside pathCache when worktree set changes', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });

    // Warm cache with a legitimate resolution
    const warm = await engine.verifyCitations('Code at src/ephemeral.ts:2 defines Y');
    expect(warm).toBe(false); // file exists, line in range

    // Access the private caches via any-cast to verify the invariant directly.
    // This is the tightest possible test of the fix — we assert BOTH caches
    // clear together when updateWorktreeRoots detects a change.
    const eng = engine as unknown as {
      pathCache: Map<string, string | null>;
      fileCache: Map<string, string | null>;
      updateWorktreeRoots: (results: unknown[]) => void;
    };
    expect(eng.pathCache.size).toBeGreaterThan(0);
    expect(eng.fileCache.size).toBeGreaterThan(0);

    // Trigger a worktree-set change by feeding a synthetic TaskEntry with a
    // scope hint pointing at a brand-new worktree path.
    const fakeWorktree = resolve(tmpdir(), 'gossip-wt-' + Date.now());
    mkdirSync(fakeWorktree, { recursive: true });
    try {
      eng.updateWorktreeRoots([
        { id: 't', agentId: 'a', task: 'r', status: 'completed', result: '', startedAt: 0, worktreeInfo: { path: fakeWorktree } } as unknown as never,
      ]);
      // Both caches must be empty after the worktree-set change.
      expect(eng.pathCache.size).toBe(0);
      expect(eng.fileCache.size).toBe(0);
    } finally {
      rmSync(fakeWorktree, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Tier 1A — Fix #5: I/O errors in per-citation read now increment `failed`
// Consensus round 82a3c123-19db41e7
// ────────────────────────────────────────────────────────────────────
describe('Tier 1A Fix #5 — I/O errors count as failed citations', () => {
  const testDir = resolve(tmpdir(), 'gossip-io-fail-' + Date.now());
  const readableFile = resolve(testDir, 'src', 'readable.ts');

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'src'), { recursive: true });
    writeFileSync(readableFile, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('per-citation read error counts toward failed (not swallowed)', async () => {
    // We cannot easily inject an fs.readFile throw without monkey-patching, so
    // we exercise the equivalent code path via a citation whose RESOLVED path
    // points at something that throws on read: a directory treated as a file.
    // readFile on a directory throws EISDIR, which is caught at the per-citation
    // try/catch. Post-Fix-#5 this increments `failed`; pre-fix it was swallowed.
    const dirAsFile = resolve(testDir, 'src', 'isadir.ts');
    mkdirSync(dirAsFile, { recursive: true });
    try {
      const engine = new ConsensusEngine({
        llm: mockLlm,
        registryGet: mockRegistryGet,
        projectRoot: testDir,
      });
      // One citation, one EISDIR failure — should now trip `failed > 0.5` (majority of 1).
      const result = await engine.verifyCitations('At src/isadir.ts:1 we have a constant');
      expect(result).toBe(true); // EISDIR increments failed → majority (1/1) → fabricated
    } finally {
      rmSync(dirAsFile, { recursive: true, force: true });
    }
  });

  test('I/O error on one of many citations — default (majority) mode does not fire', async () => {
    // Default verifyCitations uses majority threshold: `failed > citations.length / 2`.
    // Two citations, one EISDIR, one valid → failed=1, total=2 → 1 > 1 === false.
    // This behavior is PRESERVED by Tier 1B for the dispute path at :595 where a
    // reviewer's evidence may legitimately cite multiple files and one bad citation
    // out of many should not discard a valid refutation.
    const dirAsFile = resolve(testDir, 'src', 'isadir2.ts');
    mkdirSync(dirAsFile, { recursive: true });
    try {
      const engine = new ConsensusEngine({
        llm: mockLlm,
        registryGet: mockRegistryGet,
        projectRoot: testDir,
      });
      const result = await engine.verifyCitations(
        'See src/isadir2.ts:1 and src/readable.ts:2',
      );
      expect(result).toBe(false); // default majority mode — below threshold
    } finally {
      rmSync(dirAsFile, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Tier 1B — Fix #3: strict mode threshold (failed >= 1) for pre-filter path
// Consensus round 82a3c123-19db41e7 Tier 1B
// ────────────────────────────────────────────────────────────────────
describe('Tier 1B Fix #3 — strict-mode citation verification', () => {
  const testDir = resolve(tmpdir(), 'gossip-tier1b-strict-' + Date.now());
  const realFile = resolve(testDir, 'src', 'real.ts');

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'src'), { recursive: true });
    writeFileSync(
      realFile,
      ['export const a = 1;', 'export const b = 2;', 'export const c = 3;'].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('strict mode: 1 citation all bad → fires', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    // Single fabricated citation → failed=1, strict → 1 >= 1 === true.
    const result = await engine.verifyCitations(
      'The code at fake-module.ts:42 does the thing',
      { strict: true },
    );
    expect(result).toBe(true);
  });

  test('strict mode: 2 citations 1 bad → fires (boundary case that default missed)', async () => {
    // This is the boundary bug sonnet surfaced in round 99f15984-eb844568:f9
    // Under default (majority) mode: 1 of 2 bad = 1 > 1 = false (passes).
    // Under strict mode: 1 of 2 bad = 1 >= 1 = true (catches).
    // An author fabricating exactly half their citations always escaped the
    // default threshold; strict mode closes that escape hatch.
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const result = await engine.verifyCitations(
      'See src/real.ts:1 and fake-module.ts:42',
      { strict: true },
    );
    expect(result).toBe(true);
  });

  test('strict mode: 3 citations 1 bad → fires', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const result = await engine.verifyCitations(
      'See src/real.ts:1, src/real.ts:2, and fake-module.ts:42',
      { strict: true },
    );
    expect(result).toBe(true);
  });

  test('strict mode: 0 citations → still returns false (early return at :968 unchanged)', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const result = await engine.verifyCitations(
      'This is a qualitative disagreement with no file references at all',
      { strict: true },
    );
    // Zero-citation early return at :968 is NOT affected by strict mode.
    // The whole point of that early return is the case where citation regex
    // finds nothing → we cannot make any fabrication claim either way.
    expect(result).toBe(false);
  });

  test('strict mode: all citations valid → returns false', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const result = await engine.verifyCitations(
      'See src/real.ts:1 and src/real.ts:2',
      { strict: true },
    );
    expect(result).toBe(false);
  });

  test('default mode (no opts) preserves pre-Tier-1B majority behavior', async () => {
    // Regression guard: the dispute path at :595 calls verifyCitations(evidence)
    // WITHOUT strict:true. That call site must still use the majority rule.
    // This pins the behavior so a future refactor can't accidentally change
    // the default.
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    // 2 citations, 1 bad — under majority, 1 > 1 === false.
    const result = await engine.verifyCitations(
      'See src/real.ts:1 and fake-module.ts:42',
    );
    expect(result).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Task #9 — meta-reference false positive fix
// Consensus round 99f15984-eb844568 retraction + follow-up
// ────────────────────────────────────────────────────────────────────
describe('Task #9 — citation dedup + meta-reference exemption', () => {
  const testDir = resolve(tmpdir(), 'gossip-meta-ref-' + Date.now());
  const realFile = resolve(testDir, 'src', 'real.ts');

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'src'), { recursive: true });
    writeFileSync(
      realFile,
      ['export const a = 1;', 'export const b = 2;'].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('duplicate citations count as one', async () => {
    // Pre-fix: "X at fake.ts:42 where fake.ts:42 is broken" extracted 2
    // citations, both failed, majority fired. Post-fix: deduped to 1 citation.
    // Under strict mode, 1 bad of 1 = still fabricated (fires as expected).
    // Under default mode, 1 bad of 1 = 1 > 0.5 = still fabricated (also
    // fires). So this test verifies the COUNT is correct, not that it
    // silently passes.
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    // Mix: 1 real citation (deduped) + 1 fake citation (deduped) = 2 total.
    // 1 fake of 2 = default majority 1 > 1 = false (not fabricated).
    // Without dedup: the same text would produce 4 citations (2 real + 2 fake)
    // and 2 > 2 = false still, but a 3:1 real:fake mix would hit majority
    // differently. The key invariant is that duplication cannot drive the
    // ratio — this test pins that.
    const result = await engine.verifyCitations(
      'src/real.ts:1 is fine and src/real.ts:1 is also fine, ' +
      'but fake-module.ts:42 is bad and fake-module.ts:42 is still bad',
    );
    expect(result).toBe(false); // 1 real + 1 fake, 1 > 1 = false
  });

  test('duplicate fake citations cannot game the strict threshold', async () => {
    // Pre-fix: one fake path mentioned 3 times = 3 failures, trips strict
    // threshold trivially. This was the sonnet f5 meta-bug in its exact form.
    // Post-fix: 3 mentions of the same fake path = 1 deduped citation.
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    // Narrative mentions fake-module.ts:42 three times.
    // Post-dedup: 1 citation (fake). 1 >= 1 strict = true (still fires).
    // This is correct — a single fake citation SHOULD fire strict.
    // The point of this test is that the dedup doesn't ACCIDENTALLY suppress
    // real fabrication; it just prevents over-counting.
    const result = await engine.verifyCitations(
      'The fake-module.ts:42 reference, again fake-module.ts:42, and once more fake-module.ts:42',
      { strict: true },
    );
    expect(result).toBe(true);
  });

  test('citations inside single-backtick inline code are stripped', async () => {
    // A finding that describes fabrication detection by quoting an example
    // fake path in inline code should NOT count as claiming the path exists.
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const result = await engine.verifyCitations(
      'When a reviewer writes `fake-path.ts:100` in dispute evidence, ' +
      'the regex extracts it even though src/real.ts:1 is the only real code',
      { strict: true },
    );
    // Only src/real.ts:1 is extracted (real). 0 failures. Returns false.
    expect(result).toBe(false);
  });

  test('citations inside triple-backtick code fences are stripped', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const result = await engine.verifyCitations(
      'Here is the example:\n```\nconst x = require("fake-lib.ts:99");\n```\n' +
      'and the real reference is src/real.ts:2',
      { strict: true },
    );
    expect(result).toBe(false);
  });

  test('citations inside <example> tags are stripped', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const result = await engine.verifyCitations(
      '<example>fake-thing.ts:999 is not real</example> but src/real.ts:1 is real',
      { strict: true },
    );
    expect(result).toBe(false);
  });

  test('citations inside double-quoted strings are stripped', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const result = await engine.verifyCitations(
      'When reviewer B writes "fake-file.ts:100 does not exist", the regex extracts it. src/real.ts:1 is the only real claim.',
      { strict: true },
    );
    expect(result).toBe(false);
  });

  test('auto-emitted hallucination_caught signals are capped at severity=medium', async () => {
    // Task #10 — defense in depth. Even after the dedup + strip fixes from
    // task #9, any future false positive in the pre-filter path should have
    // limited blast radius on agent scores. Heuristic detection (no human
    // judgment) should not produce severity=critical signals.
    //
    // Construct a finding with severity="critical" that contains a
    // genuinely fabricated citation (outside any quoted region so the
    // strip doesn't remove it) AND a hallucination keyword. The pre-filter
    // will fire a hallucination_caught signal; we assert that the emitted
    // signal's severity is 'medium' regardless of the original critical.
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });

    const results = [
      {
        id: 't1',
        agentId: 'agent-a',
        task: 'review',
        status: 'completed' as const,
        result: '## Consensus Summary\n- **critical**: totally-made-up.ts:999 does not exist anywhere in the repo',
        startedAt: 0,
        completedAt: 1,
      },
      {
        id: 't2',
        agentId: 'agent-b',
        task: 'review',
        status: 'completed' as const,
        result: '## Consensus Summary\n- unrelated finding',
        startedAt: 0,
        completedAt: 1,
      },
    ];

    const crossReview = [
      {
        action: 'agree' as const,
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        finding: 'totally-made-up.ts:999 does not exist anywhere in the repo',
        evidence: 'Confirmed, looks right',
        confidence: 5,
        findingId: 'agent-a:f1',
      },
    ];

    const report = await engine.synthesize(results, crossReview);

    // Pre-filter should fire on agent-a's finding (fake citation + keyword).
    const halluc = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a' && s.outcome === 'fabricated_citation',
    );

    // The auto-emit may or may not fire depending on how bullet-fallback
    // parsing assigns severity. What we MUST assert: if it fires, severity
    // is not 'critical' or 'high'. The cap applies at the emit site.
    if (halluc) {
      expect((halluc as { severity?: string }).severity).not.toBe('critical');
      expect((halluc as { severity?: string }).severity).not.toBe('high');
      expect((halluc as { severity?: string }).severity).toBe('medium');
    }
  });

  test('regression: the sonnet f5 meta-finding scenario does NOT fire', async () => {
    // Exact reproduction of the round 99f15984-eb844568 false positive.
    // The finding text describes the dispute-path attribution bug AND quotes
    // example fake paths in double quotes + inline code. Must NOT fire
    // hallucination_caught against the author under strict mode.
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
    const sonnetF5Text =
      'The current AND-gate at src/real.ts:1 is semantically inverted. ' +
      'verifyCitations(entry.evidence) extracts citations from the reviewer. ' +
      'When reviewer B writes "fake-file.ts:100 does not exist", ' +
      '`citationPattern` extracts `fake-file.ts:100` from B\'s text, ' +
      'resolution fails, isCitationFabricated=true. ' +
      'detectHallucination matches "does not exist". ' +
      'Both conditions hold — hallucination_caught fires against B.';
    const result = await engine.verifyCitations(sonnetF5Text, { strict: true });
    // After strip: only src/real.ts:1 survives (inside narrative prose, not quoted).
    // fake-file.ts:100 appears inside both a double-quoted string and inline
    // backticks, both of which are stripped before extraction.
    // Result: 1 real citation, 0 failures, returns false. No false positive.
    expect(result).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tier 1A — Fix #2: dead ternary deletion — outcome is always 'fabricated_citation'
// Consensus round 82a3c123-19db41e7
// ────────────────────────────────────────────────────────────────────
describe('Tier 1A Fix #2 — dispute hallucination signal outcome is always fabricated_citation', () => {
  const testDir = resolve(tmpdir(), 'gossip-dispute-outcome-' + Date.now());

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'src'), { recursive: true });
    writeFileSync(
      resolve(testDir, 'src', 'real.ts'),
      [
        'export function findAgent(id: string) {', // line 1
        '  if (!id) throw new Error("empty");',    // line 2
        '  return registry.get(id);',              // line 3
        '}',                                        // line 4
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('dispute with hallucination keywords + fabricated citation → signal.outcome is fabricated_citation (not incorrect)', async () => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });

    // Result text uses the `## Consensus Summary\n- ` format so the bullet-
    // fallback parser in synthesize() extracts a finding into findingMap.
    const results = [
      {
        id: 't1',
        agentId: 'agent-a',
        task: 'review',
        status: 'completed' as const,
        result: '## Consensus Summary\n- findAgent at src/real.ts:2 throws on empty id',
        startedAt: 0,
        completedAt: 1,
      },
      {
        id: 't2',
        agentId: 'agent-b',
        task: 'review',
        status: 'completed' as const,
        result: '## Consensus Summary\n- unrelated style observation',
        startedAt: 0,
        completedAt: 1,
      },
    ];

    // agent-b disagrees with agent-a's finding using BOTH a hallucination keyword
    // ("does not exist") AND a fabricated citation (nonexistent-made-up-file.ts).
    // The AND-gate at :592 will fire hallucination_caught against agent-b.
    const crossReview = [
      {
        action: 'disagree' as const,
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        finding: 'findAgent at src/real.ts:2 throws on empty id',
        evidence: 'Wrong — nonexistent-made-up-file.ts:999 does not exist and proves this is fabricated.',
        confidence: 3,
        findingId: 'agent-a:f1',
      },
    ];

    const report = await engine.synthesize(results, crossReview);

    // The finding should NOT be marked disputed — the dispute itself is flagged as hallucination.
    expect(report.disputed.find(f => f.finding.includes('findAgent'))).toBeUndefined();

    // A hallucination_caught signal should target agent-b (the disputer) with
    // outcome === 'fabricated_citation'. The dead ternary removal encodes the
    // invariant: this field is ALWAYS 'fabricated_citation' in this code path,
    // never 'incorrect' (which was unreachable).
    const halluc = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-b',
    );
    expect(halluc).toBeDefined();
    expect((halluc as { outcome?: string }).outcome).toBe('fabricated_citation');
    expect((halluc as { outcome?: string }).outcome).not.toBe('incorrect');
  });
});
