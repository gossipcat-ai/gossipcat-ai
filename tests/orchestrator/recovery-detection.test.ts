/**
 * Failed-skill recovery detection — unit tests.
 *
 * GitHub issue #572. Symmetric inverse of the passed-skill drift gate
 * (drift-detection.test.ts): a `failed` skill whose accuracy recovers gets a
 * path back via two consecutive Wilson lower-bound confirmations above
 * RECOVERY_FLOOR (K=2), transitioning to `pending` (NOT `passed` — the skill
 * still must clear normal MIN_EVIDENCE=80 graduation; recovery only lifts
 * suppression).
 *
 * Statistical invariant: recovery anchors on failed_at / recovery_strike_at,
 * drift anchors on passed_at / drift_strike_at — DISJOINT signal populations,
 * each spends its own α (HANDBOOK invariant #11). K=2 independent windows →
 * α² false-promote.
 */

import {
  resolveVerdict,
  DRIFT_DEMOTE_STRIKES,
  type SkillSnapshot,
} from '../../packages/orchestrator/src/check-effectiveness';

const NOW = Date.parse('2026-06-13T12:00:00Z');

function failedSnapshot(overrides: Partial<SkillSnapshot> = {}): SkillSnapshot {
  return {
    baseline_accuracy_correct: 70,
    baseline_accuracy_hallucinated: 30,
    bound_at: new Date(NOW - 60 * 86400_000).toISOString(),
    status: 'failed',
    migration_count: 3,
    failed_at: new Date(NOW - 20 * 86400_000).toISOString(),
    ...overrides,
  };
}

// Recovery gate ------------------------------------------------------------

describe('Recovery gate — failed snapshot', () => {
  it('PAUSED when no recoveryDelta supplied', () => {
    const snap = failedSnapshot();
    const v = resolveVerdict(snap, { correct: 0, hallucinated: 0 }, NOW, {});
    expect(v.status).toBe('failed');
    expect(v.shouldUpdate).toBe(false);
    expect(v.newSnapshotFields).toBeUndefined();
  });

  it('failed with NO failed_at → stamps failed_at, stays failed', () => {
    const snap = failedSnapshot({ failed_at: undefined });
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { recoveryDelta: { correct: 80, hallucinated: 0 } }, // would otherwise confirm
    );
    expect(v.status).toBe('failed');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.status).toBe('failed');
    expect(v.newSnapshotFields?.failed_at).toBe(new Date(NOW).toISOString());
    // No strike progress yet — clock just started.
    expect(v.newSnapshotFields?.recovery_strikes).toBeUndefined();
  });

  it('window not full (< 80 fresh signals) stays failed without writeback', () => {
    const snap = failedSnapshot();
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { recoveryDelta: { correct: 50, hallucinated: 10 } }, // 60 < 80
    );
    expect(v.status).toBe('failed');
    expect(v.shouldUpdate).toBe(false);
  });

  it('sparse window below floor stays failed (no confirmation)', () => {
    const snap = failedSnapshot({ recovery_strikes: 0 });
    // 80 signals at 60% — below the 0.75 floor; Wilson lower bound < 0.75.
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { recoveryDelta: { correct: 48, hallucinated: 32 } },
    );
    expect(v.status).toBe('failed');
    expect(v.shouldUpdate).toBe(false);
  });

  it('K=2: first confirming window stays failed, increments recovery_strikes', () => {
    const snap = failedSnapshot({ recovery_strikes: 0 });
    // 80 signals at 100% — well above the 0.75 floor; Wilson lower bound > 0.75.
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { recoveryDelta: { correct: 80, hallucinated: 0 } },
    );
    expect(v.status).toBe('failed');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.status).toBe('failed');
    expect(v.newSnapshotFields?.recovery_strikes).toBe(1);
    expect(v.newSnapshotFields?.recovery_strike_at).toBe(new Date(NOW).toISOString());
  });

  it(`K=${DRIFT_DEMOTE_STRIKES}: second confirming window → pending, clears recovery fields`, () => {
    const snap = failedSnapshot({
      recovery_strikes: 1,
      recovery_strike_at: new Date(NOW - 60 * 60_000).toISOString(),
    });
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { recoveryDelta: { correct: 80, hallucinated: 0 } },
    );
    expect(v.status).toBe('pending');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.status).toBe('pending');
    expect(v.newSnapshotFields?.recovered_at).toBe(new Date(NOW).toISOString());
    expect(v.newSnapshotFields?.failed_at).toBeUndefined();
    expect(v.newSnapshotFields?.recovery_strikes).toBe(0);
    expect(v.newSnapshotFields?.recovery_strike_at).toBeUndefined();
    expect(v.newSnapshotFields?.verdict_method).toBeUndefined();
  });

  it('confirming-then-NON-confirming → recovery_strikes reset to 0', () => {
    const snap = failedSnapshot({
      recovery_strikes: 1,
      recovery_strike_at: new Date(NOW - 60 * 60_000).toISOString(),
    });
    // 80 signals at 50% — below floor; Wilson lower bound < 0.75 → not confirming.
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { recoveryDelta: { correct: 40, hallucinated: 40 } },
    );
    expect(v.status).toBe('failed');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.status).toBe('failed');
    expect(v.newSnapshotFields?.recovery_strikes).toBe(0);
    expect(v.newSnapshotFields?.recovery_strike_at).toBeUndefined();
  });

  it('non-confirming window with no prior strike → no writeback (steady state)', () => {
    const snap = failedSnapshot({ recovery_strikes: 0 });
    const v = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { recoveryDelta: { correct: 40, hallucinated: 40 } }, // 50% below floor
    );
    expect(v.status).toBe('failed');
    expect(v.shouldUpdate).toBe(false);
  });

  it('two consecutive confirming windows (independent anchors) → pending', () => {
    // Strike-1: confirming window since failed_at.
    const snap = failedSnapshot({ recovery_strikes: 0 });
    const v1 = resolveVerdict(
      snap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { recoveryDelta: { correct: 78, hallucinated: 2 } }, // ~97.5%, confirms
    );
    expect(v1.newSnapshotFields?.recovery_strikes).toBe(1);
    expect(v1.newSnapshotFields?.recovery_strike_at).toBe(new Date(NOW).toISOString());

    // Strike-2: fresh window anchored at recovery_strike_at (independent).
    const snap2 = failedSnapshot({
      recovery_strikes: 1,
      recovery_strike_at: v1.newSnapshotFields!.recovery_strike_at as string,
    });
    const v2 = resolveVerdict(
      snap2,
      { correct: 0, hallucinated: 0 },
      NOW + 80 * 60_000,
      { recoveryDelta: { correct: 78, hallucinated: 2 } }, // fresh 80, confirms
    );
    expect(v2.status).toBe('pending');
    expect(v2.newSnapshotFields?.recovered_at).toBeDefined();
    expect(v2.newSnapshotFields?.failed_at).toBeUndefined();
    expect(v2.newSnapshotFields?.recovery_strike_at).toBeUndefined();
  });
});

// Regression — drift gate unaffected, fresh failing skill still graduates path
// -------------------------------------------------------------------------

describe('Recovery gate — regression guards', () => {
  it('passed skill still drifts (resolvePassedDrift unaffected)', () => {
    const passedSnap: SkillSnapshot = {
      baseline_accuracy_correct: 70,
      baseline_accuracy_hallucinated: 30,
      bound_at: new Date(NOW - 30 * 86400_000).toISOString(),
      status: 'passed',
      migration_count: 3,
      passed_at: new Date(NOW - 10 * 86400_000).toISOString(),
      passed_baseline_rate: 0.85,
      drift_strikes: 1,
    };
    const v = resolveVerdict(
      passedSnap,
      { correct: 0, hallucinated: 0 },
      NOW,
      { driftDelta: { correct: 40, hallucinated: 40 } }, // 50% fails vs 0.85
    );
    expect(v.status).toBe('inconclusive');
    expect(v.newSnapshotFields?.regressed_from_passed_at).toBeDefined();
  });

  it('fresh pending skill below MIN_EVIDENCE still returns pending', () => {
    const pendingSnap: SkillSnapshot = {
      baseline_accuracy_correct: 70,
      baseline_accuracy_hallucinated: 30,
      bound_at: new Date(NOW - 1 * 86400_000).toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    const v = resolveVerdict(
      pendingSnap,
      { correct: 30, hallucinated: 10 }, // 40 < 80
      NOW,
    );
    expect(v.status).toBe('pending');
    expect(v.shouldUpdate).toBe(false);
  });

  it('re-failing after a prior recovery clears stale recovered_at and re-stamps failed_at', () => {
    // A skill that previously recovered (failed→pending) carries a recovered_at
    // stamp. If it now fails again, the new failed snapshot must start a fresh
    // recovery clock (failed_at) and NOT carry the stale recovered_at forward.
    const reFailingSnap: SkillSnapshot = {
      baseline_accuracy_correct: 70,
      baseline_accuracy_hallucinated: 30,
      bound_at: new Date(NOW - 30 * 86400_000).toISOString(),
      status: 'pending',
      migration_count: 3,
      recovered_at: new Date(NOW - 5 * 86400_000).toISOString(),
    };
    const v = resolveVerdict(
      reFailingSnap,
      { correct: 20, hallucinated: 60 }, // 25% over 80 samples → Wilson failed
      NOW,
    );
    expect(v.status).toBe('failed');
    expect(v.newSnapshotFields?.failed_at).toBeDefined();
    // Stale recovered_at must be cleared on re-fail (write-only diagnostic).
    expect(v.newSnapshotFields).toHaveProperty('recovered_at', undefined);
  });
});
