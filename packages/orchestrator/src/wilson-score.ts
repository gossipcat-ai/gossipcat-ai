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
 * Standard normal quantile for (1 - alpha/2).
 *
 * For the two alpha values this prototype uses (0.025 and 0.05) we inline
 * the constant to avoid pulling in a full inverse-normal implementation for
 * a drop-in experiment.
 *
 *   alpha = 0.05  → two-sided 95% → z = 1.959964 ≈ 1.96
 *   alpha = 0.025 → two-sided 97.5% → z = 2.241403 ≈ 2.24
 */
function zForAlpha(alpha: number): number {
  if (Math.abs(alpha - 0.05) < 1e-9) return 1.959964;
  if (Math.abs(alpha - 0.025) < 1e-9) return 2.241403;
  // Fallback — Beasley-Springer-Moro would be overkill for a prototype.
  // Callers outside the {0.025, 0.05} set get a reasonable approximation
  // from 1.96 but should wire in a real qnorm before production use.
  return 1.959964;
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
