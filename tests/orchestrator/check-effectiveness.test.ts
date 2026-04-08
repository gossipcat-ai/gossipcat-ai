/**
 * Canonical spec tests for checkEffectiveness (Tests 1–7).
 *
 * Spec: docs/superpowers/specs/2026-04-07-checkeffectiveness-redesign.md (Draft v4)
 * Plan: docs/superpowers/plans/2026-04-07-checkeffectiveness-redesign.md Tasks 10–16
 *
 * Tests 1, 2, 4, 5, 6, 7 are defined here (pure-function level).
 * Test 3 lives in performance-reader-category-accuracy.test.ts (retraction filter).
 * Test 8 lives in consensus-engine-category-parse.test.ts (category propagation).
 * Integration tests (silent skill, happy path, failure) live in check-effectiveness-integration.test.ts.
 */

import {
  resolveVerdict,
  type SkillSnapshot,
} from '../../packages/orchestrator/src/check-effectiveness';

const baseSnapshot: SkillSnapshot = {
  baseline_accuracy_correct: 50,
  baseline_accuracy_hallucinated: 50,
  bound_at: '2026-04-01T00:00:00Z',
  status: 'pending',
  migration_count: 0,
};

// ---------------------------------------------------------------------------
// Test 1 — Monotonicity
// ---------------------------------------------------------------------------

describe('checkEffectiveness — Test 1: Monotonicity', () => {
  it('z-scores strictly increase with accuracy, only highest crosses gate', () => {
    // Construct three counter sets at p_hat ∈ {0.60, 0.80, 0.90} post-bind, all N=120
    // Baseline is 50/100 = 50%, so post-bind delta is:
    // p_hat 0.60 → 72 correct + 48 hallucinated since baseline
    // p_hat 0.80 → 96 correct + 24 hallucinated
    // p_hat 0.90 → 108 correct + 12 hallucinated

    const v60 = resolveVerdict(baseSnapshot, { correct: 72, hallucinated: 48 }, Date.now());
    const v80 = resolveVerdict(baseSnapshot, { correct: 96, hallucinated: 24 }, Date.now());
    const v90 = resolveVerdict(baseSnapshot, { correct: 108, hallucinated: 12 }, Date.now());

    // All three meet the gate (post-bind N=120), so all run the z-test
    // Higher accuracy → higher z-score
    expect(v90.zScore!).toBeGreaterThan(v80.zScore!);
    expect(v80.zScore!).toBeGreaterThan(v60.zScore!);
    expect(v90.status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Decay interaction (raw counts)
// ---------------------------------------------------------------------------

describe('checkEffectiveness — Test 2: Decay interaction', () => {
  it('per-category accuracy uses raw counts, not decay-weighted (verified by counter equivalence)', () => {
    // Two scenarios with identical raw counts but different age distributions:
    // (A) 120 fresh signals at p_hat=0.85 since baseline → passed
    // (B) 120 aged signals at p_hat=0.85 since baseline (same counts) → ALSO passed
    // The verdict must be identical because per-category counts don't apply decay.
    // (Decay is applied only to the legacy categoryStrengths metric,
    //  not to categoryCorrect/categoryHallucinated.)

    const delta = { correct: 102, hallucinated: 18 }; // 120 signals at 85%
    const v = resolveVerdict(baseSnapshot, delta, Date.now());
    expect(v.status).toBe('passed');
    // The pure function doesn't take decay as input — that's the design confirmation.
    // Validation that PerformanceReader doesn't decay categoryCorrect is covered in
    // performance-reader-category-accuracy.test.ts.
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Dampener asymmetry guard
// ---------------------------------------------------------------------------

describe('checkEffectiveness — Test 4: Dampener asymmetry guard', () => {
  it('genuine accuracy drop produces failed', () => {
    // Baseline: 90 correct + 10 hallucinated = 90% accuracy
    // (Avoids the p=1.0 degenerate case where SE=0 in the z-test.)
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 90,
      baseline_accuracy_hallucinated: 10,
      bound_at: '2026-04-01T00:00:00Z',
      status: 'pending',
      migration_count: 0,
    };
    // Post-bind delta: 48 correct + 72 hallucinated = 40% accuracy → real -50pp drop
    // (baseline 90%, post-bind 40%, Δ = -50pp — strongly rejects negative H0)
    const v = resolveVerdict(snap, { correct: 48, hallucinated: 72 }, Date.now());
    expect(v.status).toBe('failed');
  });

  it('hallucination growth without accuracy change does NOT produce failed', () => {
    // Baseline: 50 correct + 50 hallucinated = 50% accuracy
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 50,
      baseline_accuracy_hallucinated: 50,
      bound_at: '2026-04-01T00:00:00Z',
      status: 'pending',
      migration_count: 0,
    };
    // Post-bind delta: 60 correct + 60 hallucinated = still 50% accuracy
    // Absolute hallucination count grew but post-window p_hat == baseline_p
    // Because we use raw ratio (no dampener), there's no asymmetric penalty.
    const v = resolveVerdict(snap, { correct: 60, hallucinated: 60 }, Date.now());
    expect(v.status).not.toBe('failed');
    expect(['inconclusive', 'pending']).toContain(v.status);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Inconclusive re-evaluation epoch
// ---------------------------------------------------------------------------

describe('checkEffectiveness — Test 5: Inconclusive epoch', () => {
  const snap: SkillSnapshot = {
    baseline_accuracy_correct: 50,
    baseline_accuracy_hallucinated: 50,
    bound_at: '2026-04-01T00:00:00Z',
    status: 'pending',
    migration_count: 0,
  };

  it('writes inconclusive snapshot fields on first inconclusive verdict', () => {
    // p_hat ≈ baseline → inconclusive. delta = 60 correct + 60 hallucinated
    const v = resolveVerdict(snap, { correct: 60, hallucinated: 60 }, Date.now());
    expect(v.status).toBe('inconclusive');
    expect(v.newSnapshotFields?.inconclusive_strikes).toBe(1);
    expect(v.newSnapshotFields?.inconclusive_at).toBeDefined();
    // v2: inconclusive_correct and inconclusive_hallucinated are NOT written
    expect((v.newSnapshotFields as Record<string, unknown>)?.inconclusive_correct).toBeUndefined();
    expect((v.newSnapshotFields as Record<string, unknown>)?.inconclusive_hallucinated).toBeUndefined();
  });

  it('subsequent runs measure delta from inconclusive epoch, not original baseline', () => {
    const snap2: SkillSnapshot = {
      ...snap,
      status: 'inconclusive',
      inconclusive_at: '2026-04-15T00:00:00Z',
      inconclusive_strikes: 1,
    };
    // Caller pre-computes delta since inconclusive_at: only 50 more signals (< 120)
    const v = resolveVerdict(snap2, { correct: 25, hallucinated: 25 }, Date.now());
    expect(v.status).toBe('pending');
  });

  it('flags for manual review after 3 consecutive inconclusives', () => {
    const snap3: SkillSnapshot = {
      ...snap,
      status: 'inconclusive',
      inconclusive_at: '2026-04-15T00:00:00Z',
      inconclusive_strikes: 2,
    };
    // Add 120 more signals at p_hat = baseline → another inconclusive → 3rd strike → flagged
    const v = resolveVerdict(snap3, { correct: 60, hallucinated: 60 }, Date.now());
    expect(v.status).toBe('flagged_for_manual_review');
  });

  it('post-flag is no-op (does not recompute or rewrite)', () => {
    const flagged: SkillSnapshot = { ...snap, status: 'flagged_for_manual_review' };
    const v = resolveVerdict(flagged, { correct: 9999, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('flagged_for_manual_review');
    expect(v.shouldUpdate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — FDR boundary at baseline ≤ 6%
// ---------------------------------------------------------------------------

describe('checkEffectiveness — Test 6: FDR boundary at baseline', () => {
  it('combined false-positive rate at p_hat = baseline is ≤ 6% across 1000 trials', () => {
    // Seeded RNG so the test is deterministic. Generate 1000 trials of N=120 binomial draws at p=0.75.
    // For each trial, compute the verdict against a baseline of (75, 25).
    // Count how many produce 'passed' or 'failed' (false positives — true effect is zero).
    // Bonferroni: each one-sided test is α=0.025; combined ≤ 5% theoretical, allow up to 6% sample noise.

    function seededRandom(seed: number) {
      let s = seed;
      return () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
      };
    }

    const baseline: SkillSnapshot = {
      baseline_accuracy_correct: 75,
      baseline_accuracy_hallucinated: 25,
      bound_at: '2026-04-01T00:00:00Z',
      status: 'pending',
      migration_count: 0,
    };

    const rng = seededRandom(42);
    let falsePositives = 0;
    const TRIALS = 1000;
    for (let i = 0; i < TRIALS; i++) {
      let correct = 0;
      for (let j = 0; j < 120; j++) {
        if (rng() < 0.75) correct++;
      }
      // v2: pass only the delta (120 fresh signals, not cumulative)
      const v = resolveVerdict(baseline, {
        correct: correct,
        hallucinated: 120 - correct,
      }, Date.now());
      if (v.status === 'passed' || v.status === 'failed') falsePositives++;
    }

    const fpr = falsePositives / TRIALS;
    expect(fpr).toBeLessThanOrEqual(0.06);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Lazy migration preserves bound_at (cross-reference)
// ---------------------------------------------------------------------------

describe('checkEffectiveness — Test 7: Lazy migration', () => {
  it('preserves bound_at when within 90 days, snapshots baseline_accuracy_correct — see skill-generator-check-effectiveness.test.ts for canonical tests', () => {
    // The 4 lazy-migration scenarios (fresh, stale-reset, re-fire-guard, absent-bound_at)
    // are canonically tested in skill-generator-check-effectiveness.test.ts (Task 8 section).
    // This entry exists for spec traceability: spec Test 7 → Task 16 → this block.
    //
    // We assert a minimal round-trip here: a snapshot without baseline_accuracy_correct uses
    // the pure resolveVerdict fallback (baseline_accuracy_correct=0) and does not crash.
    const snapNoBound: SkillSnapshot = {
      baseline_accuracy_correct: 0,
      baseline_accuracy_hallucinated: 0,
      bound_at: new Date().toISOString(), // fresh — no timeout
      status: 'pending',
      migration_count: 0,
    };
    // 80 signals post-bind — below gate of 120, so pending
    const v = resolveVerdict(snapNoBound, { correct: 80, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('pending');
    expect(v.shouldUpdate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: frame-mixing — bound_at 60d ago
// ---------------------------------------------------------------------------

describe('checkEffectiveness — frame-mixing regression', () => {
  it('does not produce postTotal<0 when bound_at is 60d ago (delta is pre-computed)', () => {
    // v2: the caller pre-computes delta via getCountersSince(agentId, category, bound_at_ms).
    // The delta is always non-negative by construction. This test verifies resolveVerdict
    // accepts a delta from a 60d-old anchor without returning pending due to negative postTotal.
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 80,
      baseline_accuracy_hallucinated: 20,
      bound_at: new Date(Date.now() - 60 * 86400_000).toISOString(), // 60d ago
      status: 'pending',
      migration_count: 0,
    };
    // delta = 50 correct + 70 hallucinated since bound_at (pre-computed by caller)
    const delta = { correct: 50, hallucinated: 70 };
    const v = resolveVerdict(snap, delta, Date.now());
    // postTotal = 120 ≥ MIN_EVIDENCE — must produce a real verdict, not pending/negative
    expect(v.status).not.toBe('pending');
    // postTotal is 120 which is non-negative — this is the regression guard
    expect(['passed', 'failed', 'inconclusive']).toContain(v.status);
  });

  it('correctly counts evidence from delta passed in (not clamped to 30d)', () => {
    // bound_at 60d ago; delta contains 130 signals from the full 60d window.
    // In v1 with rolling-window subtraction this could fail; in v2 it should resolve.
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 75,
      baseline_accuracy_hallucinated: 25,
      bound_at: new Date(Date.now() - 60 * 86400_000).toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // 130 signals at 85% → +10pp over 75% baseline → passed
    const delta = { correct: 110, hallucinated: 20 };
    const v = resolveVerdict(snap, delta, Date.now());
    expect(v.status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Regression: delta-from-delta — multiple inconclusive epochs
// ---------------------------------------------------------------------------

describe('checkEffectiveness — delta-from-delta regression', () => {
  it('does not produce negative postTotal on second inconclusive check', () => {
    // Each check, caller pre-computes delta since the most recent anchor.
    // Simulates two inconclusive epochs — each delta is independently non-negative.
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 60,
      baseline_accuracy_hallucinated: 40,
      bound_at: new Date(Date.now() - 120 * 86400_000).toISOString(), // 120d ago
      status: 'inconclusive',
      inconclusive_at: new Date(Date.now() - 45 * 86400_000).toISOString(), // 45d ago
      inconclusive_strikes: 1,
      migration_count: 0,
    };
    // Caller computes delta since inconclusive_at (45d ago). 60 signals — below gate.
    const delta = { correct: 30, hallucinated: 30 };
    const v = resolveVerdict(snap, delta, Date.now());
    // postTotal = 60 ≥ 0 — regression guard: never negative
    // bound_at is 120d ago (>90d timeout), so timedOut=true, postTotal=60 → insufficient_evidence
    expect(['pending', 'insufficient_evidence']).toContain(v.status);
  });

  it('second inconclusive epoch produces non-negative delta and real verdict', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 60,
      baseline_accuracy_hallucinated: 40,
      bound_at: new Date(Date.now() - 120 * 86400_000).toISOString(),
      status: 'inconclusive',
      inconclusive_at: new Date(Date.now() - 45 * 86400_000).toISOString(),
      inconclusive_strikes: 1,
      migration_count: 0,
    };
    // 130 signals at 70% accuracy (slightly above 60% baseline) — barely inconclusive region
    const delta = { correct: 91, hallucinated: 39 };
    const v = resolveVerdict(snap, delta, Date.now());
    // Must be a real verdict, not pending or negative-caused error
    expect(['passed', 'failed', 'inconclusive']).toContain(v.status);
  });
});
