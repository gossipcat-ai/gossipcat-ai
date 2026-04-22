/**
 * PROTOTYPE — Wilson score interval as a drop-in candidate for oneSidedZTest.
 *
 * The current one-sided z-test in check-effectiveness.ts has three known
 * statistical flaws:
 *   1. se === 0 lockout when baselineP ∈ {0, 1}. A skill with a 0/6 baseline
 *      can never graduate because the z-test's standard error collapses.
 *   2. baselineP falls back to 0.5 when baselineTotal === 0. This doubles
 *      the evidence bar vs. what the skill actually claimed.
 *   3. Claimed 80% power at n=120 is closer to 75.5% in practice.
 *
 * The Wilson score interval is a confidence interval for a binomial
 * proportion that is well-defined at p ∈ {0, 1} and at small n. By comparing
 * baseline and post CIs instead of running a z-test against a point
 * estimate, we can subsume all three flaws:
 *
 *   - Degenerate p=0 or p=1 baselines produce finite, non-zero CIs.
 *   - Sparse baselines produce wide CIs that naturally demand more evidence.
 *   - The CI overlap test has calibrated frequentist coverage.
 *
 * This file is prototype only. No integration into resolveVerdict.
 */

/**
 * Inverse standard-normal CDF (Φ⁻¹) for probability p ∈ (0, 1).
 *
 * Implementation: Peter J. Acklam's rational-approximation algorithm
 * (https://web.archive.org/web/20150910044729/http://home.online.no/~pjacklam/notes/invnorm/),
 * accurate to ~1.15e-9 over the open interval. Boundaries are handled
 * explicitly: p=0.5 → 0, p→0 → -∞ proxy, p→1 → +∞ proxy.
 *
 * This replaces a pair of hard-coded constants (alpha ∈ {0.025, 0.05}) with
 * a production-grade quantile so Wilson intervals can be requested at any
 * alpha without silently falling back to z≈1.96.
 */
function inverseNormalCDF(p: number): number {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }

  // Acklam's coefficients.
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  // Break-points.
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  let r: number;
  let x: number;

  if (p < pLow) {
    // Lower region — rational approximation in log-space.
    q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    // Central region — rational approximation around the median.
    q = p - 0.5;
    r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    // Upper region — mirror of the lower region.
    q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(
        ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]
      ) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  return x;
}

/**
 * Critical z for a two-sided test at significance level alpha.
 *
 * Returns Φ⁻¹(1 − alpha/2), i.e. the quantile such that a two-sided
 * z-test rejects when |z| exceeds it.
 *
 *   alpha = 0.05  → 1.959964 (classic 1.96)
 *   alpha = 0.025 → 2.241403
 *   alpha = 0.01  → 2.575829
 *
 * Domain:
 *   - alpha ∈ (0, 1): returns a real z. z→+∞ as alpha→0, z→0 as alpha→1.
 *   - alpha = 0.5: returns Φ⁻¹(0.75) ≈ 0.6745 (NOT zero — zero occurs only as alpha→1).
 *   - alpha ≥ 1 or alpha ≤ 0: throws RangeError.
 *   - For alpha > 0.5 the return is still positive but small (e.g. alpha=0.9 → ≈0.126).
 *     Wilson callers are expected to use alpha ∈ (0, 0.5]; no clamp applied.
 *
 * Exported for direct use and for targeted unit tests.
 */
export function zForAlpha(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(
      `zForAlpha: alpha must be in (0, 1), got ${alpha}`,
    );
  }
  return inverseNormalCDF(1 - alpha / 2);
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Returns [lower, upper] bounds clamped to [0, 1].
 *
 * Edge cases:
 *   - total === 0: returns the full [0, 1] interval (no information).
 *   - correct === 0 or correct === total: the interval is finite and
 *     does NOT collapse to a point — this is the key property that fixes
 *     the z-test's degenerate-baseline lockout.
 */
export function wilsonScoreInterval(
  correct: number,
  total: number,
  alpha: number,
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 1 };
  if (correct < 0 || correct > total) {
    // Defensive clamp — shouldn't happen with well-formed counters.
    correct = Math.max(0, Math.min(correct, total));
  }
  const z = zForAlpha(alpha);
  const n = total;
  const pHat = correct / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return { lower, upper };
}

export type WilsonVerdict = 'passed' | 'failed' | 'pending';

/**
 * CI-overlap verdict: strict improvement or regression requires disjoint
 * intervals. Touching intervals → pending (conservative).
 *
 * This is the structural replacement for the two-sided z-test arms in
 * resolveVerdict. The alpha plumbing here should match the z-test Bonferroni
 * split (α=0.025 per arm) to keep false-positive rates comparable.
 */
export function wilsonVerdict(
  baseline: { correct: number; total: number },
  post: { correct: number; total: number },
  alpha: number,
): WilsonVerdict {
  const b = wilsonScoreInterval(baseline.correct, baseline.total, alpha);
  const p = wilsonScoreInterval(post.correct, post.total, alpha);
  if (p.lower > b.upper) return 'passed';
  if (p.upper < b.lower) return 'failed';
  return 'pending';
}
