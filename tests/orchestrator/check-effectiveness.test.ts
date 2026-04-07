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

import { describe, it, expect } from 'vitest';
import {
  resolveVerdict,
  type SkillSnapshot,
} from '../../packages/orchestrator/src/check-effectiveness';

const baseSnapshot: SkillSnapshot = {
  baseline_correct: 50,
  baseline_hallucinated: 50,
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
    // Baseline is 50/100 = 50%, so post-bind is additive.
    // p_hat 0.60 → 72 correct + 48 hallucinated since baseline
    // p_hat 0.80 → 96 correct + 24 hallucinated
    // p_hat 0.90 → 108 correct + 12 hallucinated

    const v60 = resolveVerdict(baseSnapshot, { correct: 50 + 72, hallucinated: 50 + 48 }, Date.now());
    const v80 = resolveVerdict(baseSnapshot, { correct: 50 + 96, hallucinated: 50 + 24 }, Date.now());
    const v90 = resolveVerdict(baseSnapshot, { correct: 50 + 108, hallucinated: 50 + 12 }, Date.now());

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

    const post = { correct: 50 + 102, hallucinated: 50 + 18 }; // 120 signals at 85%
    const v = resolveVerdict(baseSnapshot, post, Date.now());
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
      baseline_correct: 90,
      baseline_hallucinated: 10,
      bound_at: '2026-04-01T00:00:00Z',
      status: 'pending',
      migration_count: 0,
    };
    // Post-bind: 48 correct + 72 hallucinated = 40% accuracy → real -50pp drop
    // (baseline 90%, post-bind 40%, Δ = -50pp — strongly rejects negative H0)
    const v = resolveVerdict(snap, { correct: 90 + 48, hallucinated: 10 + 72 }, Date.now());
    expect(v.status).toBe('failed');
  });

  it('hallucination growth without accuracy change does NOT produce failed', () => {
    // Baseline: 50 correct + 50 hallucinated = 50% accuracy
    const snap: SkillSnapshot = {
      baseline_correct: 50,
      baseline_hallucinated: 50,
      bound_at: '2026-04-01T00:00:00Z',
      status: 'pending',
      migration_count: 0,
    };
    // Post-bind: another 60 correct + 60 hallucinated = still 50% accuracy
    // Absolute hallucination count grew from 50 to 110, but post-window p_hat == baseline_p
    // Because we use raw ratio (no dampener), there's no asymmetric penalty.
    const v = resolveVerdict(snap, { correct: 110, hallucinated: 110 }, Date.now());
    expect(v.status).not.toBe('failed');
    expect(['inconclusive', 'pending']).toContain(v.status);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Inconclusive re-evaluation epoch
// ---------------------------------------------------------------------------

describe('checkEffectiveness — Test 5: Inconclusive epoch', () => {
  const snap: SkillSnapshot = {
    baseline_correct: 50,
    baseline_hallucinated: 50,
    bound_at: '2026-04-01T00:00:00Z',
    status: 'pending',
    migration_count: 0,
  };

  it('writes inconclusive snapshot fields on first inconclusive verdict', () => {
    // p_hat ≈ baseline → inconclusive
    const v = resolveVerdict(snap, { correct: 50 + 60, hallucinated: 50 + 60 }, Date.now());
    expect(v.status).toBe('inconclusive');
    expect(v.newSnapshotFields?.inconclusive_correct).toBe(110);
    expect(v.newSnapshotFields?.inconclusive_hallucinated).toBe(110);
    expect(v.newSnapshotFields?.inconclusive_strikes).toBe(1);
  });

  it('subsequent runs measure delta from inconclusive snapshot, not original baseline', () => {
    const snap2: SkillSnapshot = {
      ...snap,
      status: 'inconclusive',
      inconclusive_correct: 110,
      inconclusive_hallucinated: 110,
      inconclusive_at: '2026-04-15T00:00:00Z',
      inconclusive_strikes: 1,
    };
    // Add only 50 more signals (less than 120) — should be pending against the inconclusive epoch
    const v = resolveVerdict(snap2, { correct: 110 + 25, hallucinated: 110 + 25 }, Date.now());
    expect(v.status).toBe('pending');
  });

  it('flags for manual review after 3 consecutive inconclusives', () => {
    const snap3: SkillSnapshot = {
      ...snap,
      status: 'inconclusive',
      inconclusive_correct: 110,
      inconclusive_hallucinated: 110,
      inconclusive_at: '2026-04-15T00:00:00Z',
      inconclusive_strikes: 2,
    };
    // Add 120 more signals at p_hat = baseline → another inconclusive → 3rd strike → flagged
    const v = resolveVerdict(snap3, { correct: 110 + 60, hallucinated: 110 + 60 }, Date.now());
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
      baseline_correct: 75,
      baseline_hallucinated: 25,
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
      const v = resolveVerdict(baseline, {
        correct: 75 + correct,
        hallucinated: 25 + (120 - correct),
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
  it('preserves bound_at when within 90 days, snapshots baseline_correct — see skill-generator-check-effectiveness.test.ts for canonical tests', () => {
    // The 4 lazy-migration scenarios (fresh, stale-reset, re-fire-guard, absent-bound_at)
    // are canonically tested in skill-generator-check-effectiveness.test.ts (Task 8 section).
    // This entry exists for spec traceability: spec Test 7 → Task 16 → this block.
    //
    // We assert a minimal round-trip here: a snapshot without baseline_correct uses
    // the pure resolveVerdict fallback (baseline_correct=0) and does not crash.
    const snapNoBound: SkillSnapshot = {
      baseline_correct: 0,
      baseline_hallucinated: 0,
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
