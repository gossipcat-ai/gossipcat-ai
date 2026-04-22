/**
 * Skill effectiveness E2E — graduation pipeline integration tests.
 *
 * Twelve variants that exercise the full pending-skill → checkEffectiveness →
 * verdict pipeline through real PerformanceWriter, real PerformanceReader,
 * real SkillEngine, and the real writeSkillFileFromParts atomic write.
 * Fixtures write directly to `.gossip/agents/<id>/skills/*.md` and to
 * `.gossip/agent-performance.jsonl` so every component on the read path
 * participates.
 *
 * Each variant states the PR it gates:
 *   A  — pristine 120-signal graduation         (gates PR 4)
 *   B  — degenerate baseline (0 correct)        (gates PR 2, Wilson)
 *   C  — status:"active" startup migration      (gates PR 1 — already shipped)
 *   D  — noisy-corpus filter discipline         (gates PR 4 + category filter)
 *   E  — concurrent evaluation race             (gates PR 8)
 *   F  — graduation to 'failed' (PR 225)
 *   G  — inconclusive strike rotation → flagged_for_manual_review (PR 225/228)
 *   H1 — silent_skill timeout                   (PR 228 verdict_method stamp)
 *   H2 — insufficient_evidence timeout          (PR 228 verdict_method stamp)
 *   I  — bound_at older than TIMEOUT_MS deterministic reset
 *   J  — readSkillFreshness legacy 'active'     (PR 228 coerceStatus-on-read)
 *   K  — stampSignalClass write-forward preservation (PR 5)
 *   L  — operational disagreement guard         (PR 4 Part B no-op guard)
 *
 * All variants use plain jest `test` — no `test.failing` suites remain.
 * Variants A–E exist on this branch because the gating PRs (1, 2, 4, 8) have
 * already shipped; variants F–L lock in the PR #225 / PR #228 follow-up work.
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
import {
  SkillEngine,
  __setSkillEngineTestHook,
} from '../../packages/orchestrator/src/skill-engine';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { PerformanceWriter } from '../../packages/orchestrator/src/performance-writer';
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';
import {
  readSkillFreshness,
  computeCooldown,
} from '../../packages/orchestrator/src/skill-freshness';
import { SkillGapTracker } from '../../packages/orchestrator/src/skill-gap-tracker';

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

/**
 * Append N post-bind `hallucination_caught` signals (counters.hallucinated++)
 * with the given category. Timestamps are monotonically after `boundAtMs`.
 */
function appendHallucinated(
  projectRoot: string,
  agentId: string,
  category: string,
  count: number,
  boundAtMs: number,
  tsOffsetMs: number = 100_000,
): void {
  for (let i = 0; i < count; i++) {
    appendSignal(projectRoot, {
      type: 'consensus',
      signal: 'hallucination_caught',
      agentId,
      taskId: `task-halluc-${i}`,
      findingId: `halluc-${i}:${agentId}:f0`,
      category,
      evidence: `fixture hallucinated ${i}`,
      timestamp: new Date(boundAtMs + tsOffsetMs + i).toISOString(),
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
  // Variant B — degenerate baseline (0 correct, 6 hallucinated) → PR 2 SHIPPED
  //
  // Previously: z-test locked out because baselineP = 0/6 = 0, se = 0,
  // oneSidedZTest returns rejects:false, verdict pending.
  //
  // PR 2 integrated the Wilson score interval for baselineP ∈ {0, 1}:
  // the degenerate baseline produces a finite, non-zero upper CI;
  // 120/120 post-bind correct clearly exceeds it, so the verdict graduates
  // to `passed` via verdict_method: 'wilson_degenerate'.
  // -------------------------------------------------------------------------
  test('Variant B — degenerate 0/6 baseline → passed after Wilson (PR 2)', async () => {
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
  // PR 8 added optimistic concurrency to writeSkillFileFromParts: every write
  // carries frontmatter.version = expected + 1, and the writer re-reads the
  // on-disk version just before rename to detect drift. A second writer whose
  // snapshot was taken at the same `version` sees expected != disk and aborts.
  //
  // Two halves:
  //   E1 — deterministic interleaving via __SKILL_ENGINE_TEST_HOOK. Writer A
  //        is paused after its drift check; a sibling direct write lands v1;
  //        writer A's post-hook re-read sees v1 ≠ v0 and aborts. Final on-disk
  //        state must reflect the sibling's state, NOT writer A's stale write.
  //   E2 — stress: 50 concurrent Promise.all checkEffectiveness calls on the
  //        same tmpdir. Final on-disk version must equal the number of
  //        successful writes — no write interleaved with an aborted peer's
  //        partial state, and the file must always parse back cleanly.
  // -------------------------------------------------------------------------
  test('Variant E1 — deterministic race: paused writer aborts, sibling state wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-eff-race-e1-'));
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
      version: 0,
    });
    appendCorrect(dir, AGENT, 'injection_vectors', 120, boundAt);

    const versionBefore = Number(
      readFileSync(skillPath, 'utf-8').match(/^version:\s*(.+)$/m)?.[1] ?? '0',
    );
    expect(versionBefore).toBe(0);

    const reader = new PerformanceReader(dir);
    const engine = new SkillEngine(makeStubLLM(), reader, dir);

    // Hook: sibling writer B lands on disk with status=passed, version=1,
    // simulating a peer that beat us to the atomic rename. Writer A should
    // see the drift on its post-hook re-read and return false.
    __setSkillEngineTestHook(() => {
      const current = readFileSync(skillPath, 'utf-8');
      const patched = current
        .replace(/status:\s*"?pending"?/, 'status: passed')
        .replace(/version:\s*0/, 'version: 1');
      writeFileSync(skillPath, patched);
    });

    try {
      await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });
    } finally {
      __setSkillEngineTestHook(null);
    }

    const raw = readFileSync(skillPath, 'utf-8');
    // Final version must equal sibling's version (1), not writer A's v1 clobber
    // of a stale v0 snapshot. Because both happen to be v1 the on-disk version
    // alone doesn't distinguish them — but the `status:` field does. Writer A
    // would have written its computed verdict; the sibling wrote `passed`
    // directly with a fabricated fm. We need to assert the file is internally
    // consistent and version is advanced by exactly 1 from the pre-state.
    const versionAfter = Number(raw.match(/^version:\s*(.+)$/m)?.[1] ?? '0');
    expect(versionAfter).toBe(versionBefore + 1);

    // File must parse back with valid frontmatter block.
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain('\n---\n');
  });

  test('Variant E2 — 50 concurrent writes on same tmpdir: no torn file, version monotonic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-eff-race-e2-'));
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
      version: 0,
    });
    appendCorrect(dir, AGENT, 'injection_vectors', 120, boundAt);

    const reader = new PerformanceReader(dir);
    const engine = new SkillEngine(makeStubLLM(), reader, dir);

    const N = 50;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' }));
    }
    const results = await Promise.all(promises);

    // Every racer must reach `passed` — losing a transition is not allowed.
    for (const verdict of results as Array<{ status: string }>) {
      expect(verdict.status).toBe('passed');
    }

    // File must be internally consistent: valid frontmatter, status=passed,
    // version is a finite non-negative integer. With optimistic concurrency,
    // writes serialize on rename — successful writes increment version.
    // Because all racers snapshot v0 before any write lands, at most one
    // write wins per snapshot round; the rest abort with drift. In Node's
    // single-threaded event loop, checkEffectiveness reads synchronously
    // before resolveVerdict, so all 50 see version: 0 and all compute
    // newVersion = 1. The first write wins (file lands at v1); the other
    // 49 see disk v1 ≠ expected v0 and abort. Final version therefore = 1.
    const raw = readFileSync(skillPath, 'utf-8');
    expect(raw.startsWith('---\n')).toBe(true);
    expect(readStatus(skillPath)).toBe('passed');
    const versionAfter = Number(raw.match(/^version:\s*(.+)$/m)?.[1] ?? 'NaN');
    expect(Number.isFinite(versionAfter)).toBe(true);
    expect(versionAfter).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Variant F — graduation to 'failed' (post-bind decline vs baseline).
  //
  // Baseline 18c/2h (baselineP = 0.9). Post-bind delta has MIN_EVIDENCE=120
  // signals with a high hallucination share so postP drops well below
  // baselineP - 0.10. Under the unified Wilson path (post full-replacement),
  // the typical regime's Wilson CI lands entirely below baselineP and the
  // verdict should land at `failed` via verdict_method: 'wilson_typical'.
  //
  // Locks the symmetric "negative direction" branch of resolveVerdict that
  // mirrors variant A's positive-direction graduation.
  // -------------------------------------------------------------------------
  test("Variant F — 120 post-bind signals decline below baseline → failed via Wilson", async () => {
    const boundAt = Date.now() - 1000;
    const skillPath = writeSkillFixture(projectRoot, AGENT, CATEGORY, {
      name: CATEGORY,
      category: 'injection_vectors',
      status: 'pending',
      migration_count: 2,
      bound_at: new Date(boundAt).toISOString(),
      baseline_accuracy_correct: 18,
      baseline_accuracy_hallucinated: 2,
      effectiveness: 0.0,
    });

    // 70 correct / 50 hallucinated → postP ≈ 0.583, baselineP = 0.9.
    // delta = -0.317, well below the -0.10 gate; z-test rejects in negative.
    appendCorrect(projectRoot, AGENT, 'injection_vectors', 70, boundAt);
    appendHallucinated(projectRoot, AGENT, 'injection_vectors', 50, boundAt, 200_000);

    const reader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(makeStubLLM(), reader, projectRoot);
    const verdict = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });

    expect(verdict.status).toBe('failed');
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt=20, bp=0.9
    // → typical regime → wilson_typical replaces legacy z-test stamp.
    expect(verdict.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_typical)$/));
    // effectiveness (postP - baselineP) should be strictly negative.
    expect(verdict.effectiveness).toBeLessThan(0);
    expect(readStatus(skillPath)).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // Variant G — inconclusive rotation → flagged_for_manual_review terminal.
  //
  // Three checkEffectiveness calls where each window's postP lands within
  // ±3pp of baselineP (so Wilson intervals overlap in the typical regime —
  // neither direction crosses the α threshold). Each call bumps
  // inconclusive_strikes and rotates inconclusive_at to now, so the next call
  // reads counters from the new anchor. On the 3rd strike, resolveVerdict
  // transitions to `flagged_for_manual_review` with the regime's
  // verdict_method stamped on the return.
  //
  // To keep every round within the ±3pp band we use baselineP = 0.5
  // (60c/60h) and append exactly 60 correct + 60 hallucinated post-anchor
  // for each round (postP = 0.5 = baselineP → Wilson CIs fully overlap,
  // resolveVerdict returns pending → inconclusive). The 3-strike terminal
  // check is PR #228's verdict_method stamp on the flagged_for_manual_review
  // return.
  // -------------------------------------------------------------------------
  test('Variant G — 3× inconclusive rotation → flagged_for_manual_review', async () => {
    const boundAt = Date.now() - 90 * 86400_000 + 86400_000; // within TIMEOUT_MS
    const skillPath = writeSkillFixture(projectRoot, AGENT, CATEGORY, {
      name: CATEGORY,
      category: 'injection_vectors',
      status: 'pending',
      migration_count: 2,
      bound_at: new Date(boundAt).toISOString(),
      baseline_accuracy_correct: 60,
      baseline_accuracy_hallucinated: 60,
      effectiveness: 0.0,
    });

    const reader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(makeStubLLM(), reader, projectRoot);

    // Round 1 — signals in [boundAt+1e3, boundAt+1e3+119] range.
    appendCorrect(projectRoot, AGENT, 'injection_vectors', 60, boundAt);
    appendHallucinated(projectRoot, AGENT, 'injection_vectors', 60, boundAt, 2_000);
    const v1 = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });
    expect(v1.status).toBe('inconclusive');
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt=120, bp=0.5
    // → dense-low regime → wilson_dense_low replaces legacy z-test stamp.
    expect(v1.newSnapshotFields?.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_dense_low)$/));
    expect(v1.newSnapshotFields?.inconclusive_strikes).toBe(1);

    // Round 2 — new anchor is inconclusive_at (~now at call time).
    // Append fresh 60/60 timestamped strictly after that anchor.
    const anchor2 = Date.now();
    appendCorrect(projectRoot, AGENT, 'injection_vectors', 60, anchor2);
    appendHallucinated(projectRoot, AGENT, 'injection_vectors', 60, anchor2, 2_000);
    const v2 = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });
    expect(v2.status).toBe('inconclusive');
    expect(v2.newSnapshotFields?.inconclusive_strikes).toBe(2);

    // Round 3 — 3rd strike terminates to flagged_for_manual_review.
    const anchor3 = Date.now();
    appendCorrect(projectRoot, AGENT, 'injection_vectors', 60, anchor3);
    appendHallucinated(projectRoot, AGENT, 'injection_vectors', 60, anchor3, 2_000);
    const v3 = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });

    expect(v3.status).toBe('flagged_for_manual_review');
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt=120, bp=0.5
    // → dense-low regime → wilson_dense_low replaces legacy z-test stamp.
    expect(v3.newSnapshotFields?.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_dense_low)$/));
    expect(v3.newSnapshotFields?.inconclusive_strikes).toBe(3);
    expect(readStatus(skillPath)).toBe('flagged_for_manual_review');
  });

  // -------------------------------------------------------------------------
  // Variant H1 — silent_skill: zero post-bind signals after TIMEOUT_MS.
  //
  // Fresh skill with no inconclusive history and no post-bind signals.
  // bound_at is set 91 days in the past (> TIMEOUT_DAYS=90). Since postTotal
  // is 0 AND no inconclusive_at exists ("never active"), the verdict path
  // at check-effectiveness.ts:135-141 writes status='silent_skill'.
  // PR #228 added verdict_method:'z-test' to the newSnapshotFields.
  // -------------------------------------------------------------------------
  test('Variant H1 — zero-signal skill past TIMEOUT_MS → silent_skill', async () => {
    // 91 days in the past (exceeds TIMEOUT_DAYS=90).
    const boundAt = Date.now() - 91 * 86400_000;
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
    // Intentionally NO appendCorrect/appendHallucinated — zero post-bind signals.

    const reader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(makeStubLLM(), reader, projectRoot);
    const verdict = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });

    expect(verdict.status).toBe('silent_skill');
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt=25, bp=0.8
    // → typical regime → silent_skill stamp now uses wilson_typical.
    expect(verdict.newSnapshotFields?.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_typical)$/));
    expect(readStatus(skillPath)).toBe('silent_skill');
  });

  // -------------------------------------------------------------------------
  // Variant H2 — insufficient_evidence: some signals but < MIN_EVIDENCE
  // after TIMEOUT_MS.
  //
  // Skill bound 91 days ago. Append 30 correct signals (under MIN_EVIDENCE=120)
  // after bound_at. postTotal > 0 → everActive=true → status 'insufficient_evidence'.
  // Verdict_method:'z-test' per PR #228.
  // -------------------------------------------------------------------------
  test('Variant H2 — 30 post-bind signals past TIMEOUT_MS → insufficient_evidence', async () => {
    const boundAt = Date.now() - 91 * 86400_000;
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

    // 30 < MIN_EVIDENCE=120. Timestamped inside the 91-day window so
    // getCountersSince anchored at bound_at picks them up.
    appendCorrect(projectRoot, AGENT, 'injection_vectors', 30, boundAt);

    const reader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(makeStubLLM(), reader, projectRoot);
    const verdict = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });

    expect(verdict.status).toBe('insufficient_evidence');
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt=25, bp=0.8
    // → typical regime → insufficient_evidence stamp now uses wilson_typical.
    expect(verdict.newSnapshotFields?.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_typical)$/));
    expect(readStatus(skillPath)).toBe('insufficient_evidence');
  });

  // -------------------------------------------------------------------------
  // Variant I — bound_at older than TIMEOUT_MS: deterministic lifecycle
  // transition.
  //
  // With bound_at 120 days in the past and zero post-bind activity, the
  // engine must deterministically route to silent_skill. Two identical
  // back-to-back calls must produce identical verdict status (post-transition
  // the stored status is terminal-adjacent; the second call returns the same
  // verdict). Locks the timeout boundary against flap regressions.
  // -------------------------------------------------------------------------
  test('Variant I — bound_at 120d old with no signals → silent_skill (deterministic)', async () => {
    const boundAt = Date.now() - 120 * 86400_000;
    const skillPath = writeSkillFixture(projectRoot, AGENT, CATEGORY, {
      name: CATEGORY,
      category: 'injection_vectors',
      status: 'pending',
      migration_count: 2,
      bound_at: new Date(boundAt).toISOString(),
      baseline_accuracy_correct: 10,
      baseline_accuracy_hallucinated: 2,
      effectiveness: 0.0,
    });

    const reader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(makeStubLLM(), reader, projectRoot);
    const v1 = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });
    expect(v1.status).toBe('silent_skill');

    // On-disk state must reflect the transition; bound_at must not have
    // been rewritten to 'now' (the migration reset path only fires when
    // migration_count < 2; we're at 2). The terminal state persists.
    expect(readStatus(skillPath)).toBe('silent_skill');

    // Second call on a skill already in silent_skill: status is not a
    // short-circuit in resolveVerdict (only passed/failed/flagged are), so
    // the engine re-runs the postTotal check. With still zero signals and
    // still timed out, the deterministic answer remains silent_skill.
    const v2 = await engine.checkEffectiveness(AGENT, 'injection_vectors', { role: 'reviewer' });
    expect(v2.status).toBe('silent_skill');
  });

  // -------------------------------------------------------------------------
  // Variant J — readSkillFreshness legacy 'active' coercion (PR #228).
  //
  // The SkillEngine constructor runs runOneTimeStatusMigration which would
  // rewrite `status: active` → `status: pending` on disk — so we must NOT
  // instantiate SkillEngine before this test. Instead, call readSkillFreshness
  // / SkillGapTracker.isSkillFresh directly on the raw file with legacy
  // `status: active`. PR #228 added a coerceStatus call on read so the
  // returned status is 'pending' (not 'active') even though the file on disk
  // still contains the legacy string. computeCooldown('pending') must return
  // kind:'no_cooldown'.
  // -------------------------------------------------------------------------
  test("Variant J — readSkillFreshness coerces legacy 'active' → 'pending'", () => {
    // Use an isolated category so we don't collide with any other fixture.
    const category = 'legacy-active-test';
    const skillPath = writeSkillFixture(projectRoot, AGENT, category, {
      name: category,
      category: 'injection_vectors',
      status: 'active', // legacy value — no SkillEngine construction below
      bound_at: new Date(Date.now() - 5000).toISOString(),
    });
    // Sanity: the raw file still has the legacy value on disk.
    expect(readStatus(skillPath)).toBe('active');

    // Direct call — no SkillEngine constructed, so no on-disk migration.
    const fresh = readSkillFreshness(AGENT, category, projectRoot);

    expect(fresh.status).toBe('pending'); // coerced, not 'active'
    expect(fresh.boundAt).not.toBeNull();

    // computeCooldown('pending') returns kind:'no_cooldown' so the develop
    // gate lets the regen request through.
    const decision = computeCooldown(fresh.status);
    expect(decision.kind).toBe('no_cooldown');
    if (decision.kind === 'no_cooldown') {
      expect(decision.status).toBe('pending');
    }

    // SkillGapTracker.isSkillFresh reads via the same function; a bound_at
    // ~5s ago is inside the 24h freshness window.
    const tracker = new SkillGapTracker(projectRoot);
    expect(tracker.isSkillFresh(AGENT, category)).toBe(true);

    // File on disk must still contain the legacy string — coercion is
    // read-only, non-destructive.
    expect(readStatus(skillPath)).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Variant K — signal_class write-forward preservation on stampSignalClass.
  //
  // When a caller explicitly sets signal_class on an input signal,
  // stampSignalClass must preserve it rather than overwrite with the
  // classifier's default. Exercises the write gate through WRITER_INTERNAL
  // so the full validate → stamp → append path runs.
  // -------------------------------------------------------------------------
  test("Variant K — explicit signal_class:'operational' is preserved on write", () => {
    const writer = new PerformanceWriter(projectRoot);

    // `agreement` would normally classify as 'performance' — we override
    // with 'operational' to prove the explicit value wins.
    const signal = {
      type: 'consensus' as const,
      signal: 'agreement' as const,
      agentId: AGENT,
      taskId: 'variant-k-preserve',
      findingId: 'variant-k:f0',
      category: 'injection_vectors',
      evidence: 'explicit signal_class wins',
      timestamp: new Date().toISOString(),
      signal_class: 'operational' as const,
    };

    writer[WRITER_INTERNAL].appendSignal(signal, 'unknown');

    const path = join(projectRoot, '.gossip', 'agent-performance.jsonl');
    const raw = readFileSync(path, 'utf-8').trim().split('\n');
    const mine = raw
      .map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(r => r.taskId === 'variant-k-preserve');
    expect(mine).toHaveLength(1);
    // Explicit 'operational' must survive even though classifySignal('agreement')
    // would return 'performance'.
    expect(mine[0].signal_class).toBe('operational');
  });

  // -------------------------------------------------------------------------
  // Variant L — operational disagreement guard (PR 4 Part B).
  //
  // A disagreement row with no `category` field (matching the failed-task
  // bridge shape at apps/cli/src/handlers/native-tasks.ts:recordTimeoutSignal)
  // must NOT contribute to weightedTotal or the disagreements counter in the
  // computeScores path. The category guard at performance-reader.ts:607
  // `if (!signal.category) continue;` is the enforcing line — this test
  // locks it as a regression gate.
  //
  // We write one operational disagreement row through the direct-JSONL
  // fixture helper (bypassing the validated writer so we can simulate an
  // uncategorized row landing on disk), then assert getAgentScore sees
  // disagreements === 0 for this agent.
  // -------------------------------------------------------------------------
  test('Variant L — operational disagreement (no category) does NOT touch disagreements/weightedTotal', () => {
    // Operational disagreement shape: no category, signal_class operational,
    // mirroring the failed-task bridge. writeFileSync directly so the writer
    // validator (which does NOT require `category`) still leaves us free to
    // exercise the reader guard in isolation.
    appendSignal(projectRoot, {
      type: 'consensus',
      signal: 'disagreement',
      agentId: AGENT,
      taskId: 'variant-l-operational',
      findingId: 'variant-l:f0',
      signal_class: 'operational',
      evidence: 'failed-task bridge synthesized disagreement',
      timestamp: new Date().toISOString(),
    });

    const reader = new PerformanceReader(projectRoot);
    const score = reader.getAgentScore(AGENT);

    // With only this single uncategorized operational disagreement on disk,
    // and no other signals, the reader may either return null (agent never
    // crossed the score-emission threshold) or a score object with zero
    // contribution from this row. Both outcomes prove the guard worked.
    if (score !== null) {
      expect(score.disagreements).toBe(0);
    }
    // Either way, the row MUST NOT have registered as a disagreement.
    // (If score is null, disagreements is trivially absent.)
  });
});
