/**
 * Pure functions for skill effectiveness evaluation.
 *
 * Statistical foundation:
 *   - One-sided z-test on per-category accuracy = correct / (correct + hallucinated)
 *   - Two simultaneous tests (passed-direction, failed-direction) → Bonferroni α=0.025 each
 *   - Evidence gate: ≥ MIN_EVIDENCE category-tagged signals since last snapshot
 *   - Power: ≈ 75.5% for detecting +10pp shift at p=0.75 baseline at MIN_EVIDENCE=120
 *     (verified by independent recomputation; SE_alt=0.03260, z_power=-0.690, Φ(0.690)=0.755).
 *     Raising MIN_EVIDENCE to ~148 would reach ≥80% power if false-negative cost dominates.
 */

import type { CategoryCounters } from './performance-reader';
import { wilsonVerdict } from './wilson-score';

export { CategoryCounters };

export const MIN_EVIDENCE = 120;
export const ALPHA = 0.025;
/**
 * Regime-split threshold inherited from the legacy z-test path: bt below this
 * value routes to `sparse-current` in the unified Wilson classifier; bt at or
 * above it routes to `dense-low` (bp ≤ 0.6) or `typical` (bp > 0.6).
 *
 * Preserved as the boundary by spec docs/specs/2026-04-22-wilson-full-replacement.md
 * §"Regime classification". The constant name is now historical — there is no
 * z-test path in the unified verdict — but the threshold value (20) is load-bearing
 * for regime routing.
 */
export const MIN_BASELINE_FOR_ZTEST = 20;
export const Z_CRITICAL = 1.96; // one-sided, α=0.025 — diagnostic-only zScore
export const TIMEOUT_DAYS = 90;
export const TIMEOUT_MS = TIMEOUT_DAYS * 86400_000;


export type VerdictStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'flagged_for_manual_review'
  | 'not_applicable'
  | 'silent_skill'
  | 'insufficient_evidence';

/**
 * Verdict-method tag stamped onto SkillSnapshot at writeback. The first three
 * literals are retained for migration — pre-Wilson-replacement snapshots on
 * disk may carry them and must continue to deserialize. The five `wilson_*`
 * literals correspond 1:1 to the WILSON_SCHEDULE regimes (post Option (d),
 * docs/specs/2026-04-22-wilson-full-replacement.md §"Final schedule").
 *
 * Future cleanup: once no live snapshot carries `'z-test' | 'wilson_degenerate'
 * | 'wilson_sparse'`, those three literals can be dropped (spec §Step 6,
 * out of scope here).
 */
export type VerdictMethod =
  | 'z-test'
  | 'wilson_degenerate'
  | 'wilson_sparse'
  | 'wilson_typical'
  | 'wilson_dense_low'
  | 'wilson_sparse_current'
  | 'wilson_degenerate_zero'
  | 'wilson_degenerate_one';

export interface SkillSnapshot {
  baseline_accuracy_correct: number;
  baseline_accuracy_hallucinated: number;
  bound_at: string; // ISO timestamp
  status: VerdictStatus;
  migration_count: number;
  inconclusive_at?: string;
  inconclusive_strikes?: number;
  verdict_method?: VerdictMethod;
  /**
   * Monotonic optimistic-concurrency counter. Baseline version read from
   * disk at the top of checkEffectiveness; every writeback bumps it by +1
   * after verifying the on-disk value hasn't drifted. Missing/legacy files
   * are treated as `version: 0` (rollback-safe).
   */
  version?: number;
}

export interface VerdictResult {
  status: VerdictStatus;
  effectiveness?: number; // delta in accuracy (post - baseline)
  zScore?: number;
  verdict_method?: VerdictMethod;
  shouldUpdate: boolean; // false if terminal state
  newSnapshotFields?: Partial<SkillSnapshot>; // fields to merge into frontmatter
}

/**
 * Piecewise Wilson α schedule per docs/specs/2026-04-22-wilson-full-replacement.md
 * §"Final schedule" (Option (d), post-R5).
 *
 * Calibration source: scripts/wilson-calibration.mjs (Artifact 1) — DO NOT
 * recompute these inline; the script is the source of truth and the schedule
 * here is the audited output. The five non-dense-high regime names match the
 * five new verdict_method literals 1:1.
 */
export const WILSON_SCHEDULE = {
  typical: 0.3152839660644532,
  'dense-low': 0.21972811889648441,
  'sparse-current': 0.5490728454589844,
  'degenerate-zero': 0.025,
  'degenerate-one': 0.025,
} as const;

export type WilsonRegime = keyof typeof WILSON_SCHEDULE;

/**
 * Classify a (baselineTotal, baselineP) pair into one of the five Wilson
 * regimes. Mirrors the spec's sequential-conditional classifier:
 *
 *   bt === 0                      → 'typical' (bp defaults to 0.5 upstream)
 *   bp === 0                      → 'degenerate-zero'
 *   bp === 1                      → 'degenerate-one'
 *   bt < MIN_BASELINE_FOR_ZTEST   → 'sparse-current'
 *   bt ≥ MIN_BASELINE_FOR_ZTEST and bp ≤ 0.6 → 'dense-low'
 *   else                          → 'typical'
 *
 * `dense-high` (bp ≈ 0.9) collapses into `typical` per spec — same α, audited
 * divergence acknowledged in §"Final schedule".
 */
export function classifyRegime(baselineTotal: number, baselineP: number): WilsonRegime {
  if (baselineTotal === 0) return 'typical';
  if (baselineP === 0) return 'degenerate-zero';
  if (baselineP === 1) return 'degenerate-one';
  // strict <: routes bt ∈ [1, 19] to sparse-current; bt=20 falls through to dense-low/typical.
  if (baselineTotal < MIN_BASELINE_FOR_ZTEST) return 'sparse-current';
  // bp inclusive at 0.6: bp=0.6 routes to dense-low; bp=0.601+ routes to typical.
  if (baselineP <= 0.6) return 'dense-low';
  return 'typical';
}

const REGIME_TO_VERDICT_METHOD: Record<WilsonRegime, VerdictMethod> = {
  typical: 'wilson_typical',
  'dense-low': 'wilson_dense_low',
  'sparse-current': 'wilson_sparse_current',
  'degenerate-zero': 'wilson_degenerate_zero',
  'degenerate-one': 'wilson_degenerate_one',
};

export function oneSidedZTest(
  observed: { correct: number; total: number },
  baselineP: number,
  direction: 'positive' | 'negative',
): { rejects: boolean; zScore: number } {
  if (observed.total <= 0) return { rejects: false, zScore: 0 };
  const pHat = observed.correct / observed.total;
  const se = Math.sqrt(baselineP * (1 - baselineP) / observed.total);
  if (se === 0) return { rejects: false, zScore: 0 };
  const z = (pHat - baselineP) / se;
  const rejects = direction === 'positive' ? z > Z_CRITICAL : z < -Z_CRITICAL;
  return { rejects, zScore: z };
}

export function resolveVerdict(
  snapshot: SkillSnapshot,
  delta: CategoryCounters,
  nowMs: number,
  opts?: { role?: string },
): VerdictResult {
  // Terminal states short-circuit
  if (opts?.role === 'implementer') {
    return { status: 'not_applicable', shouldUpdate: false };
  }
  if (snapshot.status === 'flagged_for_manual_review') {
    return { status: 'flagged_for_manual_review', shouldUpdate: false };
  }
  if (snapshot.status === 'passed' || snapshot.status === 'failed') {
    return { status: snapshot.status, shouldUpdate: false };
  }

  // Delta is pre-computed by caller via getCountersSince — use directly
  const postTotal = delta.correct + delta.hallucinated;

  const baselineTotal = snapshot.baseline_accuracy_correct + snapshot.baseline_accuracy_hallucinated;
  const baselineP = baselineTotal > 0 ? snapshot.baseline_accuracy_correct / baselineTotal : 0.5;

  // Timeout check (against original bound_at, not inconclusive epoch)
  const boundAtMs = new Date(snapshot.bound_at).getTime();
  if (isNaN(boundAtMs)) {
    return { status: 'pending' as const, shouldUpdate: false };
  }
  const elapsedMs = nowMs - boundAtMs;
  const timedOut = elapsedMs >= TIMEOUT_MS;

  // Pending: not enough evidence yet.
  //
  // Per consensus 9369ebfc-a3654b51 f5, the `pending` return covers two
  // distinct sub-cases that callers may want to distinguish at the dashboard
  // layer (without growing the verdict enum here):
  //   (a) postTotal === 0 — zero history. Skill was bound but has not fired
  //       on any dispatch yet. Common for newly-bound skills before the
  //       first relevant task arrives.
  //   (b) 0 < postTotal < MIN_EVIDENCE — some history, but below the
  //       statistical gate (MIN_EVIDENCE = 120). Skill is active but
  //       hasn't accumulated enough signals for the z-test to fire.
  //
  // Both surface as `pending` because the action is the same: wait. The
  // distinction is informational only — dashboards can compute it from
  // `delta.correct + delta.hallucinated` if needed.
  // Classify the regime up front so silent_skill / insufficient_evidence /
  // inconclusive / flagged_for_manual_review stamps all carry a meaningful
  // verdict_method (the regime that *would* fire if evidence accumulated).
  const regime = classifyRegime(baselineTotal, baselineP);
  const verdictMethod = REGIME_TO_VERDICT_METHOD[regime];

  if (postTotal < MIN_EVIDENCE) {
    if (timedOut) {
      // If the skill was previously inconclusive, it had activity at some point —
      // a current postTotal===0 means evidence ran dry, not that the skill never fired.
      const everActive = postTotal > 0 || snapshot.inconclusive_at != null;
      const status: VerdictStatus = everActive ? 'insufficient_evidence' : 'silent_skill';
      return {
        status,
        shouldUpdate: true,
        newSnapshotFields: { status, verdict_method: verdictMethod },
      };
    }
    return { status: 'pending', shouldUpdate: false };
  }

  // Unified Wilson path (replaces the prior z-test + wilson_degenerate +
  // wilson_sparse three-branch matrix). Uses regime-specific α from
  // WILSON_SCHEDULE per docs/specs/2026-04-22-wilson-full-replacement.md.
  //
  // No z-test fallback exists: any skill whose Wilson CI cannot reach a
  // verdict at the current postTotal stays in the pending → inconclusive →
  // flagged lifecycle below until evidence resolves it.
  const alpha = WILSON_SCHEDULE[regime];
  const wilson = wilsonVerdict(
    { correct: snapshot.baseline_accuracy_correct, total: baselineTotal },
    { correct: delta.correct, total: postTotal },
    alpha,
  );
  const postP = delta.correct / postTotal;
  const effectiveness = postP - baselineP;

  // Diagnostic-only zScore: computed for dashboards and the monotonicity
  // guarantee in tests. Not used to drive the verdict — Wilson decides.
  // Zero variance (baselineP ∈ {0, 1}) yields zScore=0 from oneSidedZTest.
  const zDirection: 'positive' | 'negative' = postP >= baselineP ? 'positive' : 'negative';
  const zScore = oneSidedZTest({ correct: delta.correct, total: postTotal }, baselineP, zDirection).zScore;

  if (wilson === 'passed') {
    return {
      status: 'passed',
      effectiveness,
      zScore,
      verdict_method: verdictMethod,
      shouldUpdate: true,
      newSnapshotFields: { status: 'passed', verdict_method: verdictMethod },
    };
  }
  if (wilson === 'failed') {
    return {
      status: 'failed',
      effectiveness,
      zScore,
      verdict_method: verdictMethod,
      shouldUpdate: true,
      newSnapshotFields: { status: 'failed', verdict_method: verdictMethod },
    };
  }

  // Inconclusive: Wilson returned pending at MIN_EVIDENCE+ samples. Write a
  // second snapshot, increment strikes.
  //
  // Per consensus 9369ebfc-a3654b51 f4: at typical signal volumes
  // (10-20 category signals per consensus round, ~1 round/day), reaching
  // strikes >= 3 requires ~360 fresh category signals across three
  // independent MIN_EVIDENCE windows (~6-12 months for narrow categories)
  // because inconclusive_at rotates the anchor on every strike. In practice
  // the 90-day timeout fires `insufficient_evidence` long before strikes
  // accumulate, so flagged_for_manual_review is rarely reached. This is a
  // known structural property, not a bug — flagging requires strong evidence
  // by design. If we want manual review at lower volumes, the right lever is
  // lowering MIN_EVIDENCE per category, not removing strike rotation.
  const strikes = (snapshot.inconclusive_strikes ?? 0) + 1;
  if (strikes >= 3) {
    return {
      status: 'flagged_for_manual_review',
      verdict_method: verdictMethod,
      shouldUpdate: true,
      newSnapshotFields: { status: 'flagged_for_manual_review', inconclusive_strikes: strikes, verdict_method: verdictMethod },
    };
  }
  return {
    status: 'inconclusive',
    effectiveness,
    zScore,
    verdict_method: verdictMethod,
    shouldUpdate: true,
    newSnapshotFields: {
      status: 'inconclusive',
      inconclusive_at: new Date(nowMs).toISOString(),
      inconclusive_strikes: strikes,
      verdict_method: verdictMethod,
    },
  };
}
