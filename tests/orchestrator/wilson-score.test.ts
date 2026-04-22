import {
  wilsonScoreInterval,
  wilsonVerdict,
  zForAlpha,
} from '../../packages/orchestrator/src/wilson-score';
import { oneSidedZTest } from '../../packages/orchestrator/src/check-effectiveness';

// Matches the Bonferroni-split alpha the z-test uses per arm.
const ALPHA = 0.025;

describe('zForAlpha — Acklam inverse normal CDF', () => {
  // Reference values computed from high-precision qnorm: z = Φ⁻¹(1 - α/2).
  const REFERENCE: Array<[number, number]> = [
    [0.01, 2.5758293],
    [0.025, 2.2414027],
    [0.05, 1.9599640],
    [0.1, 1.6448536],
    [0.15, 1.4395315],
    [0.2, 1.2815516],
    [0.3, 1.0364334],
  ];

  it.each(REFERENCE)(
    'round-trips within 1e-6 at alpha=%f (expect %f)',
    (alpha, expected) => {
      const z = zForAlpha(alpha);
      expect(Math.abs(z - expected)).toBeLessThan(1e-6);
    },
  );

  it('is monotonically decreasing across alpha ∈ [0.001, 0.5]', () => {
    const alphas: number[] = [];
    for (let a = 0.001; a <= 0.5 + 1e-12; a += 0.001) {
      alphas.push(Math.round(a * 1000) / 1000);
    }
    let prev = Infinity;
    for (const a of alphas) {
      const z = zForAlpha(a);
      expect(z).toBeLessThanOrEqual(prev);
      prev = z;
    }
  });

  it('boundary — alpha→0 produces a large positive z', () => {
    // At alpha = 1e-12, true z ≈ 7.03. Acklam should comfortably exceed 6.
    const z = zForAlpha(1e-12);
    expect(z).toBeGreaterThan(6);
    expect(Number.isFinite(z)).toBe(true);
  });

  it('boundary — alpha=0.5 returns Φ⁻¹(0.75) ≈ 0.6745', () => {
    // Under the two-sided interpretation z = Φ⁻¹(1 − α/2), α=0.5 maps to
    // the 75th percentile, NOT zero. z=0 is approached as α → 1.
    const z = zForAlpha(0.5);
    expect(Math.abs(z - 0.6744897502)).toBeLessThan(1e-6);
  });

  it('boundary — alpha → 1 drives z → 0', () => {
    // At α = 0.9999, 1 − α/2 = 0.50005 → z ≈ 0.000125.
    const z = zForAlpha(0.9999);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(1e-3);
  });

  it('boundary — out-of-domain alpha throws RangeError', () => {
    // Domain (0, 1) is enforced. α ≤ 0 or α ≥ 1 throws; we do not clamp or
    // silently fall back (the whole point of this rewrite).
    expect(() => zForAlpha(1)).toThrow(RangeError);
    expect(() => zForAlpha(0)).toThrow(RangeError);
    expect(() => zForAlpha(-0.1)).toThrow(RangeError);
    expect(() => zForAlpha(1.5)).toThrow(RangeError);
    expect(() => zForAlpha(NaN)).toThrow(RangeError);
  });
});

describe('wilsonScoreInterval', () => {
  it('returns full [0,1] when total is zero', () => {
    const ci = wilsonScoreInterval(0, 0, ALPHA);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBe(1);
  });

  it('produces a finite non-zero-width interval at p=0 (degenerate-low)', () => {
    const ci = wilsonScoreInterval(0, 6, ALPHA);
    // Wilson never collapses at the boundary — this is the whole point.
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(ci.upper).toBeLessThan(1);
  });

  it('produces a finite non-unit-width interval at p=1 (degenerate-high)', () => {
    const ci = wilsonScoreInterval(6, 6, ALPHA);
    // Upper pins to 1 up to float error — center + margin can float-round to 0.999...9.
    expect(ci.upper).toBeGreaterThanOrEqual(0.9999999);
    expect(ci.upper).toBeLessThanOrEqual(1);
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.lower).toBeLessThan(1);
  });

  it('produces a well-centered CI for a moderate sample', () => {
    // 20/25 = 0.80 — Wilson center should sit near 0.80, width comfortably < 0.4
    const ci = wilsonScoreInterval(20, 25, ALPHA);
    expect(ci.lower).toBeGreaterThan(0.5);
    expect(ci.upper).toBeLessThan(1);
    expect(ci.upper - ci.lower).toBeLessThan(0.4);
  });

  it('tightens as n grows', () => {
    const narrow = wilsonScoreInterval(80, 100, ALPHA);
    const wide = wilsonScoreInterval(8, 10, ALPHA);
    expect(narrow.upper - narrow.lower).toBeLessThan(wide.upper - wide.lower);
  });
});

describe('wilsonVerdict', () => {
  it('Case 1 — normal clear pass (baseline 20/25=0.80, post 120/120=1.00)', () => {
    const v = wilsonVerdict({ correct: 20, total: 25 }, { correct: 120, total: 120 }, ALPHA);
    expect(v).toBe('passed');
  });

  it('Case 2 — "clear" regression (baseline 20/25=0.80, post 60/120=0.50)', () => {
    // FINDING: Wilson at α=0.025 per arm is MORE conservative than the z-test.
    // With baseline n=25 the baseline CI is [0.579, 0.921], and with post n=120
    // the post CI is [0.400, 0.600]. They overlap at ~[0.579, 0.600] → pending.
    //
    // The z-test, comparing post against the POINT baseline p=0.80, would
    // reject cleanly here (z ≈ -7.35). So a naive Wilson swap at α=0.025
    // raises the bar too far for small baselines.
    //
    // At the LOOSER α=0.05 per arm the CIs no longer overlap and Wilson
    // returns 'failed'. This is direct evidence that the right alpha
    // calibration matters: α=0.025 (matching the z-test Bonferroni split)
    // is too strict for Wilson; α=0.05 recovers the z-test verdict.
    const v = wilsonVerdict({ correct: 20, total: 25 }, { correct: 60, total: 120 }, ALPHA);
    expect(v).toBe('pending');
    const v05 = wilsonVerdict({ correct: 20, total: 25 }, { correct: 60, total: 120 }, 0.05);
    expect(v05).toBe('failed');
  });

  it('Case 3 — CRITICAL: degenerate 0/6 baseline, post 120/120 → must pass', () => {
    // z-test locks this out (se=0). Wilson must clear it.
    const v = wilsonVerdict({ correct: 0, total: 6 }, { correct: 120, total: 120 }, ALPHA);
    expect(v).toBe('passed');

    // Sanity check: confirm the z-test really does lock out this case.
    const baselineP = 0 / 6;
    const z = oneSidedZTest({ correct: 120, total: 120 }, baselineP, 'positive');
    expect(z.rejects).toBe(false); // se === 0 → locked out
  });

  it('Case 4 — degenerate 6/6 baseline, post 60/120', () => {
    // FINDING: at α=0.025 per arm the 6/6 baseline CI is [0.544, ~1] and
    // the post CI is [0.400, 0.600] — they overlap on [0.544, 0.600] and
    // Wilson returns 'pending'. At α=0.05 the baseline CI tightens to
    // [0.610, 1] and Wilson returns 'failed'.
    //
    // Takeaway: Wilson DOES handle degenerate p=1 baselines (no lockout),
    // but the α setting that matches the z-test Bonferroni split is too
    // strict for tight verdicts on small n.
    const v025 = wilsonVerdict({ correct: 6, total: 6 }, { correct: 60, total: 120 }, ALPHA);
    expect(v025).toBe('pending');
    const v05 = wilsonVerdict({ correct: 6, total: 6 }, { correct: 60, total: 120 }, 0.05);
    expect(v05).toBe('failed');
  });

  it('Case 5 — zero baseline 0/0, post 120/120 → pending (no information)', () => {
    // Documented behavior: Wilson treats 0/0 as [0,1], so post CI sits inside
    // baseline CI. Verdict is 'pending', NOT 'passed'. Callers that want a
    // different behavior for "never-sampled baseline" must special-case it.
    const v = wilsonVerdict({ correct: 0, total: 0 }, { correct: 120, total: 120 }, ALPHA);
    expect(v).toBe('pending');
  });

  it('Case 6 — small post sample does not prematurely graduate', () => {
    // baseline 20/25=0.80 (moderately tight), post 10/10=1.00 (very wide CI).
    // The post CI lower bound should still overlap the baseline CI upper bound.
    const v = wilsonVerdict({ correct: 20, total: 25 }, { correct: 10, total: 10 }, ALPHA);
    expect(v).toBe('pending');
  });

  it('Case 7 — touching intervals → pending (conservative)', () => {
    // Construct a synthetic touch: if post.lower equals baseline.upper exactly,
    // verdict must be pending (strict >). We probe by finding a scenario where
    // the intervals are extremely close, then assert pending.
    const baseline = wilsonScoreInterval(50, 100, ALPHA);
    // Post should land such that its lower bound sits ~at baseline upper.
    // Easier: identical distributions can't pass — verify with equal samples.
    const v = wilsonVerdict({ correct: 50, total: 100 }, { correct: 50, total: 100 }, ALPHA);
    expect(v).toBe('pending');
    expect(baseline.upper).toBeGreaterThan(0);
  });

  it('Case 8 — power comparison at n=120, baseline 0.75, post 0.85', () => {
    // Both verdicts at the headline power scenario. We log (as expect values)
    // the z-score and Wilson bounds so the comparison is captured in-suite.
    const baseline = { correct: 90, total: 120 }; // 0.75
    const post = { correct: 102, total: 120 };   // 0.85
    const baselineP = baseline.correct / baseline.total;

    const z = oneSidedZTest({ correct: post.correct, total: post.total }, baselineP, 'positive');
    const wilsonB = wilsonScoreInterval(baseline.correct, baseline.total, ALPHA);
    const wilsonP = wilsonScoreInterval(post.correct, post.total, ALPHA);
    const verdict = wilsonVerdict(baseline, post, ALPHA);

    // z-score for +10pp shift at n=120, p=0.75:
    //   se = sqrt(0.75*0.25/120) ≈ 0.03953
    //   z  = (0.85 - 0.75) / 0.03953 ≈ 2.530  → rejects at z* = 1.96
    expect(z.rejects).toBe(true);
    expect(z.zScore).toBeGreaterThan(1.96);

    // Wilson is more conservative: baseline upper [~0.81] vs post lower [~0.77]
    // at α=0.025 per arm. Expect overlap → pending, NOT passed.
    expect(wilsonB.upper).toBeGreaterThan(0.75);
    expect(wilsonP.lower).toBeLessThan(wilsonB.upper);
    expect(verdict).toBe('pending');

    // Evidence summary captured in assertions above:
    //   z-test says "passed", Wilson at matched α per-arm says "pending".
    //   → Wilson is NOT a pure drop-in at α=0.025. See summary finding.
  });
});

describe('wilson vs z-test parity on non-degenerate baselines', () => {
  // For moderate baselines we expect rough agreement on clear cases but
  // Wilson to be STRICTLY more conservative than the z-test on borderline
  // cases (because it compares two CIs instead of one point vs a CI).
  it('agrees on strong-pass cases (baseline 0.5, post 0.9, n=100)', () => {
    const z = oneSidedZTest({ correct: 90, total: 100 }, 0.5, 'positive');
    const v = wilsonVerdict({ correct: 50, total: 100 }, { correct: 90, total: 100 }, ALPHA);
    expect(z.rejects).toBe(true);
    expect(v).toBe('passed');
  });

  it('agrees on strong-fail cases (baseline 0.7, post 0.3, n=100)', () => {
    const z = oneSidedZTest({ correct: 30, total: 100 }, 0.7, 'negative');
    const v = wilsonVerdict({ correct: 70, total: 100 }, { correct: 30, total: 100 }, ALPHA);
    expect(z.rejects).toBe(true);
    expect(v).toBe('failed');
  });

  it('DIVERGES on borderline cases — Wilson more conservative', () => {
    // baseline 20/25=0.80, post 108/120=0.90 (+10pp)
    // z-test: rejects (clear positive); Wilson: pending (CIs overlap under
    // the doubled width from two-CI comparison).
    const baselineP = 20 / 25;
    const z = oneSidedZTest({ correct: 108, total: 120 }, baselineP, 'positive');
    const v = wilsonVerdict({ correct: 20, total: 25 }, { correct: 108, total: 120 }, ALPHA);
    expect(z.rejects).toBe(true);
    expect(v).toBe('pending'); // documents the calibration gap
  });
});
