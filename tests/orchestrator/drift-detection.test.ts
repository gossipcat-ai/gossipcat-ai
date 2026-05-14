/**
 * Passed-skill drift detection — unit tests.
 *
 * Spec: docs/specs/2026-05-13-passed-skill-drift-detection.md
 *
 * Covers steps 3-8 of the spec:
 *   - K=2 Wilson drift gate against passed_baseline_rate
 *   - Hybrid first-window test (passed_backfilled → demote on EITHER baseline fail)
 *   - PAUSED state when passed_baseline_rate is undefined
 *   - Re-graduation rotation (passed_at/passed_baseline_rate refresh, strikes reset)
 *   - Fast-path: inconclusive + regressed_from_passed_at + N=80 fail → silent_skill
 *   - Bounce-back: passed → drift-demoted → re-passed clears regressed_from_passed_at
 *
 * Companion tests for skill-engine v3 migration and skill-loader quarantine live
 * in skill-engine.test.ts and skill-loader-status-filter.test.ts respectively.
 */

import {
  resolveVerdict,
  DRIFT_DEMOTE_STRIKES,
  type SkillSnapshot,
} from '../../packages/orchestrator/src/check-effectiveness';

const NOW = Date.parse('2026-05-13T12:00:00Z');

function passedSnapshot(overrides: Partial<SkillSnapshot> = {}): SkillSnapshot {
  return {
    baseline_accuracy_correct: 70,
    baseline_accuracy_hallucinated: 30,
    bound_at: new Date(NOW - 30 * 86400_000).toISOString(),
    status: 'passed',
    migration_count: 3,
    passed_at: new Date(NOW - 10 * 86400_000).toISOString(),
    passed_baseline_rate: 0.85,
    ...overrides,
  };
}

// Drift gate ---------------------------------------------------------------

describe('Drift gate — passed snapshot', () => {
  it('PAUSED when passed_baseline_rate is undefined (insufficient backfill)', () => {
    const snap = passedSnapshot({ passed_baseline_rate: undefined });
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 }, // delta unused on passed path
      NOW,
      { driftDelta: { correct: 30, hallucinated: 50 } }, // would otherwise fail
    );
    expect(v.status).toBe('passed');
    expect(v.shouldUpdate).toBe(false);
  });

  it('window not full (< 80 fresh signals) keeps passed without writeback', () => {
    const snap = passedSnapshot();
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 40, hallucinated: 20 } }, // 60 < 80
    );
    expect(v.status).toBe('passed');
    expect(v.shouldUpdate).toBe(false);
  });

  it('K=2: first failing window stays passed, increments drift_strikes', () => {
    const snap = passedSnapshot({ drift_strikes: 0 });
    // 80 signals at 50% — well below the 0.85 baseline; Wilson upper bound < 0.85
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 40, hallucinated: 40 } },
    );
    expect(v.status).toBe('passed');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.drift_strikes).toBe(1);
    expect(v.newSnapshotFields?.status).toBe('passed');
    expect(v.newSnapshotFields?.regressed_from_passed_at).toBeUndefined();
  });

  it(`K=${DRIFT_DEMOTE_STRIKES}: second failing window demotes to inconclusive`, () => {
    const snap = passedSnapshot({ drift_strikes: 1 });
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 40, hallucinated: 40 } },
    );
    expect(v.status).toBe('inconclusive');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.status).toBe('inconclusive');
    expect(v.newSnapshotFields?.regressed_from_passed_at).toBeDefined();
    expect(v.newSnapshotFields?.drift_strikes).toBe(0); // reset after demotion
  });

  it('Wilson passes → resets drift_strikes when previously non-zero', () => {
    const snap = passedSnapshot({ drift_strikes: 1 });
    // 80 signals at 90% — comfortably above 0.85 baseline
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 72, hallucinated: 8 } },
    );
    expect(v.status).toBe('passed');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.drift_strikes).toBe(0);
  });

  it('Wilson passes with no prior strikes and no backfill → no writeback (steady state)', () => {
    const snap = passedSnapshot({ drift_strikes: 0 });
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 72, hallucinated: 8 } },
    );
    expect(v.status).toBe('passed');
    expect(v.shouldUpdate).toBe(false);
  });
});

// Hybrid first-window backfill --------------------------------------------

describe('Drift gate — hybrid backfilled first window', () => {
  it('demotes on EITHER baseline-rate OR 0.75-floor failure (K=2)', () => {
    // baseline_rate=0.95, post=0.80 → would PASS vs baseline alone (Wilson),
    // but post=0.80 with margin pushes against 0.75 — actually 80% of 80 = 64
    // correct; Wilson upper bound > 0.75. Let's pick rates where baseline fails
    // but floor passes: baseline=0.95, post=0.55 (44/80). Both fail.
    //
    // Simpler: baseline=0.95, post=0.70 (56/80). Wilson upper bound (post) ≈ 0.79
    // → < 0.95 baseline = FAIL; > 0.75 floor = PASS. Hybrid demotes via baseline.
    const snap = passedSnapshot({
      passed_baseline_rate: 0.95,
      passed_backfilled: true,
      drift_strikes: 1, // already at strike 1 → next failure demotes
    });
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 56, hallucinated: 24 } },
    );
    expect(v.status).toBe('inconclusive');
    expect(v.newSnapshotFields?.regressed_from_passed_at).toBeDefined();
  });

  it('hybrid: baseline passes but 0.75 floor fails → still demotes', () => {
    // baseline=0.55 (low reconstructed baseline from degraded signals),
    // post=0.50 (40/80). Wilson upper bound ≈ 0.61 — > 0.55 (PASS vs baseline)
    // and < 0.75 (FAIL vs floor). Hybrid catches the floor failure.
    const snap = passedSnapshot({
      passed_baseline_rate: 0.55,
      passed_backfilled: true,
      drift_strikes: 1,
    });
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 40, hallucinated: 40 } },
    );
    expect(v.status).toBe('inconclusive');
    expect(v.newSnapshotFields?.regressed_from_passed_at).toBeDefined();
  });

  it('Wilson passes both baseline AND 0.75 floor → clears passed_backfilled', () => {
    const snap = passedSnapshot({
      passed_baseline_rate: 0.80,
      passed_backfilled: true,
      drift_strikes: 0,
    });
    // post=0.95 (76/80) — Wilson upper bound well above both 0.80 and 0.75
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 76, hallucinated: 4 } },
    );
    expect(v.status).toBe('passed');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.passed_backfilled).toBeUndefined();
    expect(v.newSnapshotFields?.drift_strikes).toBe(0);
  });
});

// Fast-path silent_skill --------------------------------------------------

describe('Fast-path — drift-demoted inconclusive', () => {
  it('inconclusive + regressed_from_passed_at + post-N=80 Wilson fail → silent_skill', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 70,
      baseline_accuracy_hallucinated: 30,
      bound_at: new Date(NOW - 90 * 86400_000).toISOString(),
      status: 'inconclusive',
      migration_count: 3,
      passed_at: new Date(NOW - 60 * 86400_000).toISOString(),
      passed_baseline_rate: 0.85,
      regressed_from_passed_at: new Date(NOW - 20 * 86400_000).toISOString(),
      inconclusive_at: new Date(NOW - 20 * 86400_000).toISOString(),
    };
    const v = resolveVerdict(
      snap,
      { correct: 30, hallucinated: 50 }, // delta for normal path (unused on fast-path success)
      NOW,
      { driftDelta: { correct: 40, hallucinated: 40 } }, // 80 signals at 50%
    );
    expect(v.status).toBe('silent_skill');
    expect(v.newSnapshotFields?.status).toBe('silent_skill');
  });

  it('inconclusive + regressed_from_passed_at + Wilson passes → falls through (NOT silent)', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 70,
      baseline_accuracy_hallucinated: 30,
      bound_at: new Date(NOW - 90 * 86400_000).toISOString(),
      status: 'inconclusive',
      migration_count: 3,
      passed_at: new Date(NOW - 60 * 86400_000).toISOString(),
      passed_baseline_rate: 0.50,
      regressed_from_passed_at: new Date(NOW - 20 * 86400_000).toISOString(),
      inconclusive_at: new Date(NOW - 20 * 86400_000).toISOString(),
    };
    // post=0.95 — far above 0.50 baseline; fast-path returns null, falls through
    // to the normal inconclusive evaluation. The normal evaluation will use the
    // outer `delta` (correct: 0, hallucinated: 0 → postTotal 0 → pending).
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 76, hallucinated: 4 } },
    );
    expect(v.status).not.toBe('silent_skill');
  });
});

// Bounce-back -------------------------------------------------------------

describe('Bounce-back — passed → demoted → re-passed', () => {
  it('re-graduation clears regressed_from_passed_at, resets strikes, refreshes passed_at', () => {
    // Start: drift-demoted inconclusive with old passed_at.
    // Run a normal evaluation (no driftDelta — caller would route to the
    // inconclusive path here because we want the wilson==='passed' branch).
    const oldPassedAt = new Date(NOW - 90 * 86400_000).toISOString();
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 70,
      baseline_accuracy_hallucinated: 30,
      bound_at: new Date(NOW - 180 * 86400_000).toISOString(),
      status: 'inconclusive',
      migration_count: 3,
      passed_at: oldPassedAt,
      passed_baseline_rate: 0.70,
      regressed_from_passed_at: new Date(NOW - 30 * 86400_000).toISOString(),
      inconclusive_at: new Date(NOW - 30 * 86400_000).toISOString(),
      drift_strikes: 0,
      inconclusive_strikes: 1,
    };
    // 80 signals at 90% → Wilson re-passes.
    const v = resolveVerdict(
      snap,
      { correct: 72, hallucinated: 8 },
      NOW,
    );
    expect(v.status).toBe('passed');
    expect(v.newSnapshotFields?.status).toBe('passed');
    expect(v.newSnapshotFields?.regressed_from_passed_at).toBeUndefined();
    expect(v.newSnapshotFields?.drift_strikes).toBe(0);
    expect(v.newSnapshotFields?.inconclusive_strikes).toBe(0);
    expect(v.newSnapshotFields?.passed_backfilled).toBeUndefined();
    expect(v.newSnapshotFields?.passed_at).toBeDefined();
    expect(v.newSnapshotFields?.passed_at).not.toBe(oldPassedAt);
    expect(v.newSnapshotFields?.passed_baseline_rate).toBeCloseTo(0.9, 2);
  });
});
