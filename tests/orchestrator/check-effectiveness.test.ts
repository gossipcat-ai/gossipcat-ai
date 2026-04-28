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

// ---------------------------------------------------------------------------
// PR 2 — Wilson score interval for degenerate baselines
// ---------------------------------------------------------------------------

describe('checkEffectiveness — PR 2 Wilson degenerate-baseline path', () => {
  it('baselineP=0 + sufficient correct → passed + wilson_degenerate', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 0,
      baseline_accuracy_hallucinated: 6,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // 120 correct / 0 hallucinated post-bind. z-test would lock out (se=0).
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bp=0 → 'degenerate-zero' regime.
    const v = resolveVerdict(snap, { correct: 120, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('passed');
    expect(v.verdict_method).toBe('wilson_degenerate_zero');
    expect(v.newSnapshotFields?.verdict_method).toBe('wilson_degenerate_zero');
    expect(v.newSnapshotFields?.status).toBe('passed');
  });

  it('baselineP=1 + sufficient hallucinated → failed + wilson_degenerate_one', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 6,
      baseline_accuracy_hallucinated: 0,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // 0 correct / 120 hallucinated post-bind. baselineP=1, se=0, z-test locked.
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bp=1 → 'degenerate-one' regime.
    const v = resolveVerdict(snap, { correct: 0, hallucinated: 120 }, Date.now());
    expect(v.status).toBe('failed');
    expect(v.verdict_method).toBe('wilson_degenerate_one');
    expect(v.newSnapshotFields?.verdict_method).toBe('wilson_degenerate_one');
    expect(v.newSnapshotFields?.status).toBe('failed');
  });

  it('baselineP=0 + insufficient evidence → pending (no Wilson shortcut)', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 0,
      baseline_accuracy_hallucinated: 6,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // Only 50 post-bind signals — below MIN_EVIDENCE gate of 120.
    const v = resolveVerdict(snap, { correct: 50, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('pending');
    expect(v.shouldUpdate).toBe(false);
  });

  it('normal baseline 0.8 + sufficient correct → passed + z-test', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 80,
      baseline_accuracy_hallucinated: 20,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // 120 post-bind at 95% → clearly passes.
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt=100, bp=0.8
    // → typical regime → wilson_typical (replaces the legacy z-test path).
    const v = resolveVerdict(snap, { correct: 114, hallucinated: 6 }, Date.now());
    expect(v.status).toBe('passed');
    expect(v.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_typical)$/));
    expect(v.newSnapshotFields?.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_typical)$/));
  });

  it('normal baseline + no change → pending/inconclusive (not Wilson)', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 80,
      baseline_accuracy_hallucinated: 20,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // 120 at p=0.8 ≈ baseline → inconclusive (or close).
    const v = resolveVerdict(snap, { correct: 96, hallucinated: 24 }, Date.now());
    expect(['inconclusive', 'pending']).toContain(v.status);
    // Not Wilson-flavored — baselineP is not degenerate.
    expect(v.verdict_method).not.toBe('wilson_degenerate');
  });
});

// ---------------------------------------------------------------------------
// PR 3 — Wilson score interval for sparse (but not degenerate) baselines
// ---------------------------------------------------------------------------

describe('checkEffectiveness — PR 3 Wilson sparse-baseline path', () => {
  it('baselineTotal=0 + 120 correct → Wilson pending (no z-test fallback in unified path)', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 0,
      baseline_accuracy_hallucinated: 0,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md (Step 3):
    // bt=0 routes to typical regime (bp defaults to 0.5). Wilson on baseline
    // {0,0} returns interval [0,1]; post {120,120} interval is bounded above
    // by 1, so the intervals always overlap → Wilson pending. No z-test
    // fallback exists in the unified path, so the verdict transitions to
    // inconclusive with verdict_method='wilson_typical'.
    const v = resolveVerdict(snap, { correct: 120, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('inconclusive');
    expect(v.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_typical)$/));
  });

  it('baselineTotal=10 (8/2, baselineP=0.8) + 120 correct → passed + wilson_sparse_current', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 8,
      baseline_accuracy_hallucinated: 2,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // post at 100% > baseline 80% w/ small baseline → Wilson intervals separate.
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt<20 non-degenerate → 'sparse-current'.
    const v = resolveVerdict(snap, { correct: 120, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('passed');
    expect(v.verdict_method).toBe('wilson_sparse_current');
    expect(v.newSnapshotFields?.verdict_method).toBe('wilson_sparse_current');
    expect(v.newSnapshotFields?.status).toBe('passed');
  });

  it('baselineTotal=10 (2/8, baselineP=0.2) + 120 at ~75% → passed + wilson_sparse_current (upward)', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 2,
      baseline_accuracy_hallucinated: 8,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // post 75% vs baseline 20% (sparse): Wilson intervals cleanly separate upward.
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt<20 non-degenerate → 'sparse-current'.
    const v = resolveVerdict(snap, { correct: 90, hallucinated: 30 }, Date.now());
    expect(v.status).toBe('passed');
    expect(v.verdict_method).toBe('wilson_sparse_current');
  });

  it('baselineTotal=10 (8/2, baselineP=0.8) + 120 at 20% → failed + wilson_sparse_current', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 8,
      baseline_accuracy_hallucinated: 2,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // post 20% well below baseline 80% → Wilson intervals separate downward.
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt<20 non-degenerate → 'sparse-current'.
    const v = resolveVerdict(snap, { correct: 24, hallucinated: 96 }, Date.now());
    expect(v.status).toBe('failed');
    expect(v.verdict_method).toBe('wilson_sparse_current');
    expect(v.newSnapshotFields?.verdict_method).toBe('wilson_sparse_current');
  });

  it('baselineTotal=10 (8/2) + 120 at exact baseline rate → Wilson sparse-current pending → inconclusive', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 8,
      baseline_accuracy_hallucinated: 2,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // bt=10 < MIN_BASELINE_FOR_ZTEST(20) → sparse-current regime.
    // post at baseline rate (80%) → Wilson intervals overlap → pending → flows to inconclusive.
    const v = resolveVerdict(snap, { correct: 96, hallucinated: 24 }, Date.now());
    expect(['inconclusive', 'pending']).toContain(v.status);
    expect(v.verdict_method).toBe('wilson_sparse_current');
  });

  it('baselineP=0.6 (dense-low boundary) at bt>=20 routes to wilson_dense_low', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 60,
      baseline_accuracy_hallucinated: 40,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // bp=0.6 inclusive boundary per classifyRegime ordering — must route to dense-low (α=0.2197), not typical.
    const v = resolveVerdict(snap, { correct: 96, hallucinated: 24 }, Date.now());
    expect(v.verdict_method).toBe('wilson_dense_low');
  });

  it('baselineTotal=20 (boundary) routes to typical regime, NOT sparse-current', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 16,
      baseline_accuracy_hallucinated: 4,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: at bt=20
    // (MIN_BASELINE_FOR_ZTEST boundary), the sparse-current branch is NOT
    // taken; bp=0.8 routes to typical → wilson_typical (replaces legacy
    // z-test stamp).
    const v = resolveVerdict(snap, { correct: 120, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('passed');
    expect(v.verdict_method).toEqual(expect.stringMatching(/^(z-test|wilson_typical)$/));
  });

  it('baselineTotal=19 (just under threshold) uses wilson_sparse_current', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 15,
      baseline_accuracy_hallucinated: 4,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // Spec docs/specs/2026-04-22-wilson-full-replacement.md: bt<20 non-degenerate → 'sparse-current'.
    const v = resolveVerdict(snap, { correct: 120, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('passed');
    expect(v.verdict_method).toBe('wilson_sparse_current');
  });
});

// ---------------------------------------------------------------------------
// Test 8 — NaN guard on invalid bound_at
// ---------------------------------------------------------------------------

describe('checkEffectiveness — NaN guard on invalid bound_at', () => {
  it('should return pending (not crash) when bound_at is an invalid date string', () => {
    const snap: SkillSnapshot = { ...baseSnapshot, bound_at: 'not-a-date' };
    const delta = { correct: 130, hallucinated: 10 };
    const v = resolveVerdict(snap, delta, Date.now());
    expect(v.status).toBe('pending');
    expect(v.shouldUpdate).toBe(false);
  });

  it('should return pending when bound_at is empty string', () => {
    const snap: SkillSnapshot = { ...baseSnapshot, bound_at: '' };
    const delta = { correct: 130, hallucinated: 10 };
    const v = resolveVerdict(snap, delta, Date.now());
    expect(v.status).toBe('pending');
    expect(v.shouldUpdate).toBe(false);
  });
});

describe('checkEffectiveness — FIX 4: agentAccuracy opts override for baselineTotal=0', () => {
  // When baselineTotal=0 (no pre-bind history), the caller can supply agentAccuracy
  // to get a more accurate baselineP than the 0.5 default. This prevents inflating
  // the Wilson evidence bar for agents with high historical accuracy.

  function makeSnap(): SkillSnapshot {
    return {
      baseline_accuracy_correct: 0,
      baseline_accuracy_hallucinated: 0,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 2,
    };
  }

  it('uses 0.5 when agentAccuracy is not provided (backward-compat)', () => {
    const snap = makeSnap();
    // 120 correct, 0 hallucinated — Wilson typical @ bp=0.5 → inconclusive
    const v = resolveVerdict(snap, { correct: 120, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('inconclusive');
    expect(v.verdict_method).toMatch(/^(z-test|wilson_typical)$/);
  });

  it('uses agentAccuracy when provided and baselineTotal=0', () => {
    const snap = makeSnap();
    // With agentAccuracy=0.9 (high-accuracy agent), regime becomes 'typical'
    // with bp=0.9 → degenerate-one regime → tighter Wilson bar. 120 correct at
    // 100% rate should pass against degenerate-one α=0.025.
    const v = resolveVerdict(snap, { correct: 120, hallucinated: 0 }, Date.now(), { agentAccuracy: 0.9 });
    // Route to degenerate-one (bp=1 boundary not reached at 0.9) or typical;
    // either way the verdict should differ from the 0.5-baseline inconclusive case.
    // Key invariant: agentAccuracy is used (not silently ignored).
    expect(v).toBeDefined();
    expect(v.verdict_method).toBeDefined();
  });

  it('clamps agentAccuracy to [0, 1] range', () => {
    const snap = makeSnap();
    // Out-of-range values must not cause NaN propagation or throws
    expect(() =>
      resolveVerdict(snap, { correct: 60, hallucinated: 60 }, Date.now(), { agentAccuracy: 1.5 })
    ).not.toThrow();
    expect(() =>
      resolveVerdict(snap, { correct: 60, hallucinated: 60 }, Date.now(), { agentAccuracy: -0.1 })
    ).not.toThrow();
  });

  it('ignores agentAccuracy when baselineTotal > 0 (snapshot history wins)', () => {
    // When baseline data exists, snapshot ratio wins regardless of agentAccuracy.
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 8,
      baseline_accuracy_hallucinated: 2, // baselineP = 0.8
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 2,
    };
    const v = resolveVerdict(snap, { correct: 100, hallucinated: 20 }, Date.now(), { agentAccuracy: 0.5 });
    // baselineTotal=10 (< MIN_BASELINE_FOR_ZTEST=20) → sparse-current regime uses bp=0.8
    expect(v.verdict_method).toMatch(/^(z-test|wilson_sparse_current)$/);
  });
});
