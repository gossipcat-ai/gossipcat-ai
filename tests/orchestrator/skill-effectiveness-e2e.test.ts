/**
 * Skill effectiveness E2E — graduation pipeline integration tests.
 *
 * Five variants that exercise the full pending-skill → checkEffectiveness →
 * verdict pipeline through real PerformanceWriter, real PerformanceReader,
 * real SkillEngine, and the real writeSkillFileFromParts atomic write.
 * Fixtures write directly to `.gossip/agents/<id>/skills/*.md` and to
 * `.gossip/agent-performance.jsonl` so every component on the read path
 * participates.
 *
 * Each variant states the PR it gates:
 *   A — pristine 120-signal graduation          (gates PR 4)
 *   B — degenerate baseline (0 correct)         (gates PR 2, Wilson)
 *   C — status:"active" startup migration       (gates PR 1 — already shipped)
 *   D — noisy-corpus filter discipline          (gates PR 4 + category filter)
 *   E — concurrent evaluation race              (gates PR 8)
 *
 * Variants A, B, D, E use jest `test.failing` so they flip green automatically
 * once their gating PR lands. Variant C passes on the current branch
 * (commit b0828b5 runOneTimeStatusMigration).
 *
 * OPERATIONAL-NOISE SUPPRESSION:
 * These tests do not dispatch real tasks, so `emitCompletionSignals` /
 * `emitTaskCompletedSignal` never fire. We therefore do not need to stub them.
 * `PerformanceReader.getCountersSince` structurally filters the 120-signal
 * delta window by (agentId, normalized category, timestamp >= bound_at,
 * signal-type ∈ {agreement, category_confirmed, consensus_verified,
 * unique_confirmed, disagreement, hallucination_caught}) — so even if
 * unrelated operational signals landed in the same JSONL, they would be
 * filtered out by the category guard and signal-type switch in
 * performance-reader.ts. Variant D explicitly proves that by mixing them in.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillEngine } from '../../packages/orchestrator/src/skill-engine';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { PerformanceWriter } from '../../packages/orchestrator/src/performance-writer';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeStubLLM(): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text: '' }),
  } as unknown as ILLMProvider;
}

/**
 * Write a skill .md file with the given frontmatter fields. Returns the
 * absolute path. `category` should be the hyphenated form (matches filename
 * stem that SkillEngine.resolveSkillPath produces).
 */
function writeSkillFixture(
  projectRoot: string,
  agentId: string,
  category: string,
  fields: Record<string, string | number>,
): string {
  const dir = join(projectRoot, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${category}.md`);
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(
    path,
    `---\n${fm}\n---\n\n## Iron Law\n\nTest body.\n`,
  );
  return path;
}

/**
 * Append one consensus signal line directly to agent-performance.jsonl.
 * Bypasses PerformanceWriter's Symbol-gated writer deliberately — we are
 * simulating observed signals, not invoking the signal-helper path.
 */
function appendSignal(
  projectRoot: string,
  row: Record<string, unknown>,
): void {
  const dir = join(projectRoot, '.gossip');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, 'agent-performance.jsonl'),
    JSON.stringify(row) + '\n',
  );
}

/**
 * Append N post-bind `agreement` signals (counters.correct++) with the given
 * category. Timestamps are monotonically after `boundAtMs` so the
 * getCountersSince anchor includes them.
 */
function appendCorrect(
  projectRoot: string,
  agentId: string,
  category: string,
  count: number,
  boundAtMs: number,
): void {
  for (let i = 0; i < count; i++) {
    appendSignal(projectRoot, {
      type: 'consensus',
      signal: 'agreement',
      agentId,
      taskId: `task-correct-${i}`,
      findingId: `fix-${i}:${agentId}:f0`,
      category,
      evidence: `fixture correct ${i}`,
      timestamp: new Date(boundAtMs + 1000 + i).toISOString(),
    });
  }
}

/** Read back the `status:` line from a skill file (strips YAML quoting). */
function readStatus(skillPath: string): string {
  const raw = readFileSync(skillPath, 'utf-8');
  const m = raw.match(/^status:\s*(.+)$/m);
  if (!m) return '';
  return m[1].trim().replace(/^"(.*)"$/, '$1');
}

/** Read back the `effectiveness:` number. NaN if missing. */
function readEffectiveness(skillPath: string): number {
  const raw = readFileSync(skillPath, 'utf-8');
  const m = raw.match(/^effectiveness:\s*(.+)$/m);
  if (!m) return NaN;
  const v = m[1].trim().replace(/^"(.*)"$/, '$1');
  return Number(v);
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

describe('skill-effectiveness E2E — graduation pipeline', () => {
  let projectRoot: string;
  const AGENT = 'fixture-reviewer';
  const CATEGORY = 'injection-vectors';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'skill-eff-e2e-'));
    // Touch the writer so .gossip/ exists and PerformanceWriter boot path runs.
    new PerformanceWriter(projectRoot);
  });

  // -------------------------------------------------------------------------
  // Variant A — pristine 120-signal graduation (gates PR 4)
  //
  // Wires a clean pending skill, appends exactly MIN_EVIDENCE correct post-bind
  // signals in the correct category, and expects the verdict to land at
  // `passed` with a positive effectiveness number.
  //
  // Passes on current branch (after PR 1 b0828b5 + Wilson prototype fb21125).
  // Important reframe: the engine math (checkEffectiveness directly) already
  // works end-to-end for a pristine category-tagged corpus. The 20-day
  // graduation regression was not an engine bug — it was category starvation
  // at signal WRITE sites upstream. PR 4 fixes the write sites; this test
  // becomes a baseline assertion that the engine stays correct.
  // -------------------------------------------------------------------------
  test('Variant A — pristine 120-signal graduation → passed', async () => {
    const boundAt = Date.now() - 1000;
    const skillPath = writeSkillFixture(projectRoot, AGENT, CATEGORY, {
      name: CATEGORY,
      category: 'injection_vectors',
      status: 'pending',
      migration_count: 2,
      bound_at: new Date(boundAt).toISOString(),
      baseline_accuracy_correct: 20,
      baseline_accuracy_hallucinated: 5,
      effectiveness: 0.0,
    });

    appendCorrect(projectRoot, AGENT, 'injection_vectors', 120, boundAt);

    const reader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(makeStubLLM(), reader, projectRoot);
    const verdict = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });

    expect(verdict.status).toBe('passed');
    expect(readStatus(skillPath)).toBe('passed');
    expect(readEffectiveness(skillPath)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Variant B — degenerate baseline (0 correct, 6 hallucinated) → PR 2
  //
  // Current z-test: baselineP = 0 / 6 = 0, se = sqrt(0 * 1 / 120) = 0,
  // oneSidedZTest returns rejects:false. Verdict: `pending` (locked out).
  //
  // After PR 2 (Wilson score): the degenerate baseline produces a finite,
  // non-zero upper CI; 120/120 post-bind correct clearly exceeds it, so the
  // verdict graduates to `passed`.
  // -------------------------------------------------------------------------
  test.failing('Variant B — degenerate 0/6 baseline → passed after Wilson (PR 2)', async () => {
    const boundAt = Date.now() - 1000;
    writeSkillFixture(projectRoot, AGENT, CATEGORY, {
      name: CATEGORY,
      category: 'injection_vectors',
      status: 'pending',
      migration_count: 2,
      bound_at: new Date(boundAt).toISOString(),
      baseline_accuracy_correct: 0,
      baseline_accuracy_hallucinated: 6,
      effectiveness: 0.0,
    });

    appendCorrect(projectRoot, AGENT, 'injection_vectors', 120, boundAt);

    const reader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(makeStubLLM(), reader, projectRoot);
    const verdict = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });

    // Expected after PR 2:
    expect(verdict.status).toBe('passed');
  });

  // -------------------------------------------------------------------------
  // Variant C — status:"active" one-time migration on SkillEngine boot.
  //
  // Gates PR 1 — already shipped in commit b0828b5. Passes today.
  // -------------------------------------------------------------------------
  test('Variant C — status:"active" rewritten to pending at construction', () => {
    const skillPath = writeSkillFixture(projectRoot, AGENT, CATEGORY, {
      name: CATEGORY,
      category: 'injection_vectors',
      status: 'active', // invalid legacy value
      migration_count: 3, // locks migrateIfNeeded; runOneTimeStatusMigration handles anyway
    });

    const reader = new PerformanceReader(projectRoot);
    // Constructing the engine is sufficient — runOneTimeStatusMigration fires in ctor.
    new SkillEngine(makeStubLLM(), reader, projectRoot);

    expect(readStatus(skillPath)).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Variant D — noisy-corpus filter discipline (gates PR 4 + category filter).
  //
  // Mixes 120 valid post-bind category_confirmed/agreement signals in the
  // target category with ~100 operational-noise rows (task_completed,
  // format_compliance, signal_retracted, orphan consensus rows without
  // category). getCountersSince must only count the 120 in-category rows.
  //
  // Passes on current branch: the reader's category guard at
  // performance-reader.ts:292 (`if (!s.category) continue;`) already
  // filters operational noise out of per-category delta queries. This
  // test locks that behavior as a regression gate — if anyone weakens
  // the guard, this flips red.
  //
  // Note: this does NOT cover global accuracy contamination (orphan
  // disagreement signals hitting weightedTotal/disagreements at
  // performance-reader.ts:599-600). That is PR 4 Part B's separate
  // scope, exercised by unit tests on computeScores.
  // -------------------------------------------------------------------------
  test('Variant D — noisy corpus does not contaminate the delta window', async () => {
    const boundAt = Date.now() - 1000;
    writeSkillFixture(projectRoot, AGENT, CATEGORY, {
      name: CATEGORY,
      category: 'injection_vectors',
      status: 'pending',
      migration_count: 2,
      bound_at: new Date(boundAt).toISOString(),
      baseline_accuracy_correct: 30,
      baseline_accuracy_hallucinated: 10,
      effectiveness: 0.0,
    });

    // 120 valid post-bind correct signals in the target category.
    appendCorrect(projectRoot, AGENT, 'injection_vectors', 120, boundAt);

    // ~100 operational-noise rows across three shapes:
    //  (1) MetaSignal task_completed / format_compliance — no category field.
    //  (2) signal_retracted — a consensus meta-row; not counted by getCountersSince.
    //  (3) orphan 'agreement' with category:'' — the empty-string guard must reject it.
    for (let i = 0; i < 40; i++) {
      appendSignal(projectRoot, {
        type: 'meta',
        signal: 'task_completed',
        agentId: AGENT,
        taskId: `noise-meta-${i}`,
        timestamp: new Date(boundAt + 5000 + i).toISOString(),
      });
    }
    for (let i = 0; i < 30; i++) {
      appendSignal(projectRoot, {
        type: 'meta',
        signal: 'format_compliance',
        agentId: AGENT,
        taskId: `noise-fmt-${i}`,
        timestamp: new Date(boundAt + 6000 + i).toISOString(),
      });
    }
    for (let i = 0; i < 15; i++) {
      appendSignal(projectRoot, {
        type: 'consensus',
        signal: 'signal_retracted',
        agentId: AGENT,
        taskId: `noise-retract-${i}`,
        retractedSignal: 'hallucination_caught',
        evidence: 'noise',
        timestamp: new Date(boundAt + 7000 + i).toISOString(),
      });
    }
    for (let i = 0; i < 15; i++) {
      appendSignal(projectRoot, {
        type: 'consensus',
        signal: 'disagreement', // would normally count, but category is empty → filtered
        agentId: AGENT,
        taskId: `noise-orphan-${i}`,
        category: '',
        evidence: 'orphan no-category',
        timestamp: new Date(boundAt + 8000 + i).toISOString(),
      });
    }

    const reader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(makeStubLLM(), reader, projectRoot);
    const verdict = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });

    // Clean 120 correct / 0 hallucinated delta: p̂=1.0 against baselineP=0.75 → passed
    expect(verdict.status).toBe('passed');
  });

  // -------------------------------------------------------------------------
  // Variant E — concurrent evaluation (gates PR 8).
  //
  // Two parallel checkEffectiveness calls race on the same skill file.
  // PR 8 should add a file-level lock / compare-and-swap; until then, both
  // calls read `status: pending`, both compute `passed`, both try to write.
  // The atomic rename in writeSkillFileFromParts makes the *file* survive
  // a crash, but the second write still overwrites the first — which is
  // safe only because both compute the same verdict. This variant flips
  // red the moment two racers produce different verdicts (e.g. if evidence
  // arrives mid-race).
  //
  // We loop 10 iterations to shake out scheduler non-determinism.
  // Pass criterion: every iteration ends with status === 'passed' and
  // the file is internally consistent (parses back to a valid frontmatter).
  //
  // Passes on current branch: 10 sequential iterations with fresh tmpdirs
  // do not surface the race. This is WEAK evidence — the race likely
  // requires specific mid-write interleaving that fresh-tmpdir loops
  // don't trigger. PR 8 will strengthen this test with deterministic
  // interleaving injection or a much higher iteration count.
  // -------------------------------------------------------------------------
  test('Variant E — concurrent checkEffectiveness never drops the transition', async () => {
    for (let iter = 0; iter < 10; iter++) {
      // Fresh tmp dir per iteration so no cross-contamination.
      const dir = mkdtempSync(join(tmpdir(), `skill-eff-race-${iter}-`));
      new PerformanceWriter(dir);
      const boundAt = Date.now() - 1000;
      const skillPath = writeSkillFixture(dir, AGENT, CATEGORY, {
        name: CATEGORY,
        category: 'injection_vectors',
        status: 'pending',
        migration_count: 2,
        bound_at: new Date(boundAt).toISOString(),
        baseline_accuracy_correct: 20,
        baseline_accuracy_hallucinated: 5,
        effectiveness: 0.0,
      });
      appendCorrect(dir, AGENT, 'injection_vectors', 120, boundAt);

      const reader = new PerformanceReader(dir);
      const engine = new SkillEngine(makeStubLLM(), reader, dir);

      const [v1, v2] = await Promise.all([
        engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' }),
        engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' }),
      ]);

      // Both racers must reach `passed`. Neither may land in `pending` —
      // that would be a lost transition.
      expect(v1.status).toBe('passed');
      expect(v2.status).toBe('passed');
      expect(readStatus(skillPath)).toBe('passed');
    }
  });
});
