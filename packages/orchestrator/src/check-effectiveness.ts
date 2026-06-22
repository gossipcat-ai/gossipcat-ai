/**
 * Pure functions for skill effectiveness evaluation.
 *
 * Statistical foundation:
 *   - One-sided z-test on per-category accuracy = correct / (correct + hallucinated)
 *   - Two simultaneous tests (passed-direction, failed-direction) → Bonferroni α=0.025 each
 *   - Evidence gate: ≥ MIN_EVIDENCE category-tagged signals since last snapshot
 *   - Power: ≈ 63-65% for detecting +10pp shift at p=0.75 baseline at MIN_EVIDENCE=80
 *     (verified by independent recomputation; SE_alt=0.03993, z_power=-0.368, Φ(0.368)≈0.643).
 *     Raising MIN_EVIDENCE to ~120 reaches ≈75.5% power; ~148 reaches ≥80% if false-negative
 *     cost dominates.
 */

import type { CategoryCounters } from './performance-reader';
import { wilsonVerdict, wilsonScoreInterval } from './wilson-score';

export { CategoryCounters };

export const MIN_EVIDENCE = 80;
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
  | 'wilson_degenerate_one'
  | 'wilson_one_sample';

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
  // ── Drift-detection fields (v3 migration) ────────────────────────────
  /** ISO. Set on every passed-write. Anchor for drift detection window. */
  passed_at?: string;
  /** (correct / (correct+hallucinated)) at the moment of graduation. */
  passed_baseline_rate?: number;
  /** True if passed_at was synthesized from bound_at by v3 migration. */
  passed_backfilled?: boolean;
  /** ISO. Set on drift-demotion. Distinguishes drift-demoted from organic inconclusive. */
  regressed_from_passed_at?: string;
  /** 0 or 1. K=2 requires one prior failing window before demotion. */
  drift_strikes?: number;
  /**
   * ISO. Set when drift_strikes increments 0→1; cleared on re-graduation
   * (Wilson pass clears strikes) and on demotion. Anchors the strike-2
   * Wilson window via getCountersSince(drift_strike_at) so the two K=2
   * windows are independent — without this, the strike-2 window includes
   * strike-1's signals and the false-demote rate is α (≈0.025) instead
   * of the spec's α² (≈0.000625).
   */
  drift_strike_at?: string;
  // ── Failed-skill recovery fields (symmetric inverse of drift) ─────────
  /**
   * ISO. Set when a skill first transitions to `failed`. Anchor for the
   * recovery detection window — the recovery Wilson test compares signals
   * since failed_at against RECOVERY_FLOOR. Mirrors `passed_at`'s role for
   * drift, on the opposite (failed) population.
   */
  failed_at?: string;
  /** 0 or 1. K=2 requires one prior confirming recovery window before lifting suppression. */
  recovery_strikes?: number;
  /**
   * ISO. Set when recovery_strikes increments 0→1; cleared on transition to
   * pending (recovery succeeds) and on reset (a non-confirming window). Anchors
   * the strike-2 recovery Wilson window via getCountersSince(recovery_strike_at)
   * so the two K=2 windows are independent — mirrors drift_strike_at exactly.
   * Without this the strike-2 window includes strike-1's signals and the
   * false-promote rate is α instead of α².
   */
  recovery_strike_at?: string;
  /** ISO. Set when recovery flips a failed skill back to `pending`. Diagnostic provenance. */
  recovered_at?: string;
}

/**
 * Drift-window size — number of fresh signals required since passed_at
 * before a drift Wilson test fires. Mirrors MIN_EVIDENCE; kept as a
 * separate constant for clarity at the call site.
 */
export const DRIFT_WINDOW_SIZE = MIN_EVIDENCE;
/** K=2 — two consecutive failing drift windows demote a passed skill. */
export const DRIFT_DEMOTE_STRIKES = 2;
/** Floor used in the hybrid first-window test for backfilled passed skills. */
const HYBRID_BACKFILL_FLOOR = 0.75;
/**
 * Floor used by the failed-skill recovery gate. Mirrors HYBRID_BACKFILL_FLOOR
 * (0.75) — a recovered skill must demonstrate accuracy confidently ABOVE the
 * graduation floor before suppression is lifted. Recovery only lifts
 * suppression (failed → pending); the skill still must clear the normal
 * MIN_EVIDENCE=80 Wilson graduation afterward to reach `passed`. Setting the
 * recovery bar at the same 0.75 floor keeps the two gates symmetric.
 */
const RECOVERY_FLOOR = 0.75;

export interface VerdictResult {
  status: VerdictStatus;
  effectiveness?: number; // delta in accuracy (post - baseline)
  zScore?: number;
  verdict_method?: VerdictMethod;
  shouldUpdate: boolean; // false if terminal state
  newSnapshotFields?: Partial<SkillSnapshot>; // fields to merge into frontmatter
  /**
   * Set to `false` ONLY when shouldUpdate=true and the writeback aborted on
   * version drift (see skill-engine.writeSkillFileFromParts). Callers MUST
   * treat `persisted === false` as "no transition occurred on disk" and
   * suppress any operator-visible signal that implies the new status landed
   * (stderr logs, health-file transition counters, etc.). `undefined` means
   * either there was no writeback (shouldUpdate=false) or the writeback
   * succeeded — both are normal cases.
   *
   * Note: when shouldUpdate=true but newSnapshotFields is absent or empty,
   * writeSkillFileFromParts is not called and `persisted` stays `undefined`
   * (treated as success — no disk write was needed).
   */
  persisted?: boolean;
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
  opts?: { role?: string; agentAccuracy?: number; driftDelta?: CategoryCounters; recoveryDelta?: CategoryCounters },
): VerdictResult {
  // Terminal states short-circuit
  if (opts?.role === 'implementer') {
    return { status: 'not_applicable', shouldUpdate: false };
  }
  if (snapshot.status === 'flagged_for_manual_review') {
    return { status: 'flagged_for_manual_review', shouldUpdate: false };
  }
  if (snapshot.status === 'failed') {
    return resolveFailedRecovery(snapshot, opts?.recoveryDelta, nowMs);
  }
  if (snapshot.status === 'passed') {
    return resolvePassedDrift(snapshot, opts?.driftDelta, nowMs);
  }
  // Fast-path: drift-demoted inconclusive (regressed_from_passed_at set).
  // If a fresh post-demotion N=80 window fails Wilson vs passed_baseline_rate,
  // jump directly to silent_skill — skipping the 3-strike machinery.
  if (
    snapshot.status === 'inconclusive' &&
    snapshot.regressed_from_passed_at != null &&
    snapshot.passed_baseline_rate != null
  ) {
    const fast = resolveDriftDemotedFastPath(snapshot, opts?.driftDelta, nowMs);
    if (fast) return fast;
    // No verdict from fast-path (insufficient evidence or Wilson passes) →
    // fall through to the normal inconclusive evaluation below.
  }

  // Delta is pre-computed by caller via getCountersSince — use directly
  const postTotal = delta.correct + delta.hallucinated;

  const baselineTotal = snapshot.baseline_accuracy_correct + snapshot.baseline_accuracy_hallucinated;
  // When baselineTotal=0 (no pre-bind history), use agent-wide accuracy as the
  // baseline probability if provided by the caller. The 0.5 fallback inflates
  // the Wilson evidence bar for agents with high historical accuracy (e.g. 0.85),
  // because 0.5 routes to the 'typical' regime (α=0.315) which expects a larger
  // shift to reject. Agent-wide accuracy yields a tighter, more realistic bar.
  // Callers that can't supply agentAccuracy continue to receive 0.5 (safe default).
  const baselineP = baselineTotal > 0
    ? snapshot.baseline_accuracy_correct / baselineTotal
    : (opts?.agentAccuracy != null && Number.isFinite(opts.agentAccuracy)
        ? Math.max(0, Math.min(1, opts.agentAccuracy))
        : 0.5);

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
  //       statistical gate (MIN_EVIDENCE = 80). Skill is active but
  //       hasn't accumulated enough signals for the Wilson regime check to
  //       reach a verdict.
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

  // One-sample Wilson pre-filter for zero/sparse baselines (baselineTotal < MIN_BASELINE_FOR_ZTEST).
  //
  // Problem: when baselineTotal === 0, wilsonScoreInterval(0, 0, α) returns [0, 1] (the full
  // uninformative interval), making baseline.upper === 1.0. The CI-overlap pass condition
  // (post.lower > baseline.upper) is algebraically impossible — no post Wilson CI can have a
  // lower bound above 1.0. This means 0/18 skills with baselineTotal=0 can NEVER graduate via
  // the existing CI-overlap path, which is the primary skill-graduation blocker.
  //
  // Fix: when baseline data is sparse (baselineTotal < MIN_BASELINE_FOR_ZTEST=20), skip the
  // two-sample CI-overlap test and instead compare the post Wilson CI against a fixed prior:
  // the agent's lifetime accuracy (opts.agentAccuracy) or 0.75 if not supplied.
  //
  // This is the correct statistical comparison: we are testing whether the skill's post-bind
  // accuracy is meaningfully above the agent's known baseline performance, not against an
  // uninformative uniform prior. The 0.75 default corresponds to "typical capable agent" and
  // matches the FDR calibration target used elsewhere in this file.
  //
  // The bt>=20 CI-overlap path is UNCHANGED — this block is an early-return guard only.
  if (baselineTotal < MIN_BASELINE_FOR_ZTEST) {
    // Cap prior at 0.95 — a prior of 1.0 is statistically incoherent here.
    // When baselineTotal is sparse, opts.agentAccuracy is computed from ALL
    // signals (including the post-bind window being tested), so it can be
    // inflated to ~1.0 when the agent's only history is the current skill's
    // 120/120 run. A prior of 1.0 makes the pass condition (postCI.lower > 1.0)
    // algebraically impossible — no Wilson CI can have a lower bound above 1.0.
    // 0.95 is a conservative cap: it still penalises high-accuracy agents
    // more than the 0.75 default while remaining reachable by a strong result.
    const MAX_ONE_SAMPLE_PRIOR = 0.95;
    const prior = (opts?.agentAccuracy != null && Number.isFinite(opts.agentAccuracy))
      ? Math.max(0, Math.min(MAX_ONE_SAMPLE_PRIOR, opts.agentAccuracy))
      : 0.75;
    // Use sparse-current α regardless of regime for the one-sample path.
    // WILSON_SCHEDULE regimes were calibrated for two-sample CI-overlap comparison;
    // applying degenerate-zero α=0.025 to a one-sample vs prior comparison produces
    // an overly wide CI. sparse-current (0.549) is the calibrated one-sample target.
    const oneSampleAlpha = WILSON_SCHEDULE['sparse-current'];
    const postCI = wilsonScoreInterval(delta.correct, postTotal, oneSampleAlpha);
    const postP = delta.correct / postTotal;
    const effectiveness = postP - prior;
    const zDirection: 'positive' | 'negative' = postP >= prior ? 'positive' : 'negative';
    const zScore = oneSidedZTest({ correct: delta.correct, total: postTotal }, prior, zDirection).zScore;
    const oneSampleMethod: VerdictMethod = 'wilson_one_sample';

    if (postCI.lower > prior) {
      const nowIso = new Date(nowMs).toISOString();
      const currentRate = postTotal > 0 ? delta.correct / postTotal : 0;
      return {
        status: 'passed',
        effectiveness,
        zScore,
        verdict_method: oneSampleMethod,
        shouldUpdate: true,
        newSnapshotFields: {
          status: 'passed',
          verdict_method: oneSampleMethod,
          passed_at: nowIso,
          passed_baseline_rate: currentRate,
          regressed_from_passed_at: undefined,
          drift_strikes: 0,
          drift_strike_at: undefined,
          inconclusive_strikes: 0,
          passed_backfilled: undefined,
        },
      };
    }
    if (postCI.upper < prior) {
      return {
        status: 'failed',
        effectiveness,
        zScore,
        verdict_method: oneSampleMethod,
        shouldUpdate: true,
        newSnapshotFields: {
          status: 'failed',
          verdict_method: oneSampleMethod,
          // Stamp the recovery-window anchor at fail time (symmetric inverse of
          // passed_at). resolveFailedRecovery uses this to measure the recovery
          // window. Without it the recovery clock never starts.
          failed_at: new Date(nowMs).toISOString(),
          // Clear any recovered_at from a prior recovery — this is a fresh
          // failure, so a stale "recovered at" timestamp would be misleading in
          // the frontmatter. (Write-only diagnostic field; no logic reads it.)
          recovered_at: undefined,
        },
      };
    }
    // CI straddles prior — inconclusive, fall through to strikes logic below.
    const strikes = (snapshot.inconclusive_strikes ?? 0) + 1;
    if (strikes >= 3) {
      return {
        status: 'flagged_for_manual_review',
        verdict_method: oneSampleMethod,
        shouldUpdate: true,
        newSnapshotFields: { status: 'flagged_for_manual_review', inconclusive_strikes: strikes, verdict_method: oneSampleMethod },
      };
    }
    return {
      status: 'inconclusive',
      effectiveness,
      zScore,
      verdict_method: oneSampleMethod,
      shouldUpdate: true,
      newSnapshotFields: {
        status: 'inconclusive',
        inconclusive_at: new Date(nowMs).toISOString(),
        inconclusive_strikes: strikes,
        verdict_method: oneSampleMethod,
      },
    };
  }

  // Unified Wilson path (replaces the prior z-test + wilson_degenerate +
  // wilson_sparse three-branch matrix). Uses regime-specific α from
  // WILSON_SCHEDULE per docs/specs/2026-04-22-wilson-full-replacement.md.
  //
  // No z-test fallback exists: any skill whose Wilson CI cannot reach a
  // verdict at the current postTotal stays in the pending → inconclusive →
  // flagged lifecycle below until evidence resolves it.
  //
  // This path only runs when baselineTotal >= MIN_BASELINE_FOR_ZTEST (=20).
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
    const nowIso = new Date(nowMs).toISOString();
    const currentRate = postTotal > 0 ? delta.correct / postTotal : 0;
    return {
      status: 'passed',
      effectiveness,
      zScore,
      verdict_method: verdictMethod,
      shouldUpdate: true,
      newSnapshotFields: {
        status: 'passed',
        verdict_method: verdictMethod,
        passed_at: nowIso,
        passed_baseline_rate: currentRate,
        regressed_from_passed_at: undefined,
        drift_strikes: 0,
        drift_strike_at: undefined,
        inconclusive_strikes: 0,
        passed_backfilled: undefined,
      },
    };
  }
  if (wilson === 'failed') {
    return {
      status: 'failed',
      effectiveness,
      zScore,
      verdict_method: verdictMethod,
      shouldUpdate: true,
      newSnapshotFields: {
        status: 'failed',
        verdict_method: verdictMethod,
        // Stamp the recovery-window anchor at fail time (symmetric inverse of
        // passed_at) — starts the recovery clock for resolveFailedRecovery.
        failed_at: new Date(nowMs).toISOString(),
        // Clear any recovered_at from a prior recovery — this is a fresh
        // failure, so a stale "recovered at" timestamp would be misleading in
        // the frontmatter. (Write-only diagnostic field; no logic reads it.)
        recovered_at: undefined,
      },
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

// ---------------------------------------------------------------------------
// Drift detection — passed-skill effectiveness re-check.
//
// Pipeline gate: a skill that reached `passed` is re-tested every N=80 fresh
// signals since `passed_at`. Two consecutive Wilson lower-bound failures
// against `passed_baseline_rate` (K=2) demote the skill to `inconclusive`
// with `regressed_from_passed_at` stamped. The combined K=2 false-demote
// rate is α² = 0.000625 — a 40× reduction over a single-window test, with
// the latency cost bounded by 2 × DRIFT_WINDOW_SIZE.
//
// PAUSED state: when `passed_baseline_rate` is undefined (insufficient
// pre-graduation signal history to reconstruct the baseline on v3
// migration), drift detection is disabled until a real re-graduation
// rotates a fresh baseline in. The skill stays `passed`, keeps injecting.
//
// Hybrid first-window: for skills with `passed_backfilled: true`, the first
// drift window tests against BOTH `passed_baseline_rate` AND the 0.75
// floor (HYBRID_BACKFILL_FLOOR). Demote if EITHER fails. This catches
// bundled-default skills that graduated on the maintainer's project but
// don't generalize to the fresh user's codebase. After window 1
// (passed_backfilled cleared on Wilson pass), only the reconstructed
// baseline is tested.
// ---------------------------------------------------------------------------

function wilsonLowerBoundFailsAgainst(
  delta: CategoryCounters,
  postTotal: number,
  baseline: number,
): boolean {
  if (postTotal <= 0) return false;
  // Fast-skip when the post sample rate is at or above the baseline — drift
  // is by definition "post window is BELOW baseline." This also avoids the
  // pathological case where baseline=1.0: any finite Wilson upper bound is
  // strictly < 1, which would otherwise demote every skill whose baseline
  // was reconstructed from an all-correct history.
  const postP = delta.correct / postTotal;
  if (postP >= baseline) return false;
  // Use sparse-current α (calibrated one-sample target) — same choice the
  // one-sample baseline-vs-prior path makes. The drift test is conceptually
  // identical: one observed accuracy CI compared against a fixed prior.
  const alpha = WILSON_SCHEDULE['sparse-current'];
  const postCI = wilsonScoreInterval(delta.correct, postTotal, alpha);
  // Drift = the upper end of the post window's CI lies BELOW the baseline.
  // Equivalent to "we can confidently say post is BELOW baseline at level α."
  return postCI.upper < baseline;
}

function resolvePassedDrift(
  snapshot: SkillSnapshot,
  driftDelta: CategoryCounters | undefined,
  nowMs: number,
): VerdictResult {
  // PAUSED: no baseline rate to test against → drift detection disabled.
  if (snapshot.passed_baseline_rate == null) {
    return { status: 'passed', shouldUpdate: false };
  }
  // No drift delta supplied (caller couldn't compute or status edge case).
  if (!driftDelta) {
    return { status: 'passed', shouldUpdate: false };
  }
  const postTotal = driftDelta.correct + driftDelta.hallucinated;
  if (postTotal < DRIFT_WINDOW_SIZE) {
    // Window not full yet — keep injecting, no transition.
    return { status: 'passed', shouldUpdate: false };
  }

  const baseline = snapshot.passed_baseline_rate;
  const baselineFail = wilsonLowerBoundFailsAgainst(driftDelta, postTotal, baseline);
  // Hybrid: backfilled passed skills also tested against the 0.75 floor on
  // the first post-migration window. The reconstructed baseline may itself
  // be biased toward "already-drifted" if the pre-migration history was
  // a degraded snapshot. The floor mitigates that for window 1 only.
  const hybridFail = snapshot.passed_backfilled === true
    ? wilsonLowerBoundFailsAgainst(driftDelta, postTotal, HYBRID_BACKFILL_FLOOR)
    : false;
  const wilsonFails = baselineFail || hybridFail;

  if (wilsonFails) {
    const nextStrikes = (snapshot.drift_strikes ?? 0) + 1;
    if (nextStrikes >= DRIFT_DEMOTE_STRIKES) {
      const nowIso = new Date(nowMs).toISOString();
      return {
        status: 'inconclusive',
        shouldUpdate: true,
        newSnapshotFields: {
          status: 'inconclusive',
          inconclusive_at: nowIso,
          regressed_from_passed_at: nowIso,
          drift_strikes: 0,
          drift_strike_at: undefined,
        },
      };
    }
    // First failing window — stamp drift_strike_at so the strike-2 Wilson
    // window anchors here (independent from strike-1's window). Required
    // for the α² K=2 false-demote guarantee.
    return {
      status: 'passed',
      shouldUpdate: true,
      newSnapshotFields: {
        status: 'passed',
        drift_strikes: nextStrikes,
        drift_strike_at: new Date(nowMs).toISOString(),
      },
    };
  }

  // Wilson passes → reset strikes; clear passed_backfilled (the reconstructed
  // baseline is now corroborated by real data and the hybrid floor side of
  // the test no longer applies on subsequent windows).
  if ((snapshot.drift_strikes ?? 0) === 0 && snapshot.passed_backfilled !== true) {
    // Steady-state — nothing to write.
    return { status: 'passed', shouldUpdate: false };
  }
  return {
    status: 'passed',
    shouldUpdate: true,
    newSnapshotFields: {
      status: 'passed',
      drift_strikes: 0,
      drift_strike_at: undefined,
      passed_backfilled: undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Recovery detection — failed-skill re-test (symmetric inverse of drift).
//
// Pipeline gate: a skill that reached `failed` is suppressed from injection
// forever by skill-loader.ts. This gate gives it a path back: re-tested every
// N=80 fresh signals since `failed_at`. Two consecutive Wilson lower-bound
// CONFIRMATIONS above RECOVERY_FLOOR (K=2) lift suppression by transitioning
// the skill to `pending` with `recovered_at` stamped. The combined K=2
// false-promote rate is α² = 0.000625 — symmetric with drift's false-demote
// rate, with latency bounded by 2 × DRIFT_WINDOW_SIZE.
//
// DISJOINT POPULATION: the recovery window anchors on failed_at /
// recovery_strike_at, while drift anchors on passed_at / drift_strike_at. A
// skill is never simultaneously failed and passed, so the two gates spend
// their α budgets on non-overlapping signal populations — no α-leakage (same
// argument as HANDBOOK invariant #11). Recovery → pending (NOT passed):
// recovered skills still must clear the normal MIN_EVIDENCE=80 Wilson
// graduation. Recovery only LIFTS SUPPRESSION.
//
// PAUSED state: when no recoveryDelta is supplied (caller couldn't compute a
// window — e.g. failed_at not yet stamped on the first observation), recovery
// is disabled until a window materializes. The skill stays `failed`.
// ---------------------------------------------------------------------------

function wilsonLowerBoundConfirmsAbove(
  delta: CategoryCounters,
  postTotal: number,
  floor: number,
): boolean {
  if (postTotal <= 0) return false;
  // Fast-skip when the post sample rate is at or below the floor — recovery is
  // by definition "post window is ABOVE floor." Symmetric inverse of
  // wilsonLowerBoundFailsAgainst's postP >= baseline fast-skip.
  const postP = delta.correct / postTotal;
  if (postP <= floor) return false;
  // Use sparse-current α (calibrated one-sample target) — the SAME α the drift
  // test uses. The recovery test is conceptually identical: one observed
  // accuracy CI compared against a fixed prior, just on the other side.
  const alpha = WILSON_SCHEDULE['sparse-current'];
  const postCI = wilsonScoreInterval(delta.correct, postTotal, alpha);
  // Recovery = the lower end of the post window's CI lies ABOVE the floor.
  // Equivalent to "we can confidently say post is ABOVE floor at level α."
  return postCI.lower > floor;
}

function resolveFailedRecovery(
  snapshot: SkillSnapshot,
  recoveryDelta: CategoryCounters | undefined,
  nowMs: number,
): VerdictResult {
  // PAUSED: no recovery delta supplied (caller couldn't compute a window) →
  // recovery detection disabled, skill stays failed.
  if (!recoveryDelta) {
    return { status: 'failed', shouldUpdate: false };
  }
  // Start the clock: a failed skill with no failed_at anchor stamps one now.
  // This handles legacy `failed` snapshots written before the recovery fields
  // existed — the recovery window can only be measured from a known anchor.
  if (snapshot.failed_at == null) {
    return {
      status: 'failed',
      shouldUpdate: true,
      newSnapshotFields: { status: 'failed', failed_at: new Date(nowMs).toISOString() },
    };
  }
  const postTotal = recoveryDelta.correct + recoveryDelta.hallucinated;
  if (postTotal < DRIFT_WINDOW_SIZE) {
    // Window not full yet — stay suppressed, no transition.
    return { status: 'failed', shouldUpdate: false };
  }

  const confirm = wilsonLowerBoundConfirmsAbove(recoveryDelta, postTotal, RECOVERY_FLOOR);

  if (confirm) {
    const nextStrikes = (snapshot.recovery_strikes ?? 0) + 1;
    if (nextStrikes >= DRIFT_DEMOTE_STRIKES) {
      // K=2 confirming windows → lift suppression. Transition to pending (NOT
      // passed): the skill resumes injection and must clear normal graduation.
      const nowIso = new Date(nowMs).toISOString();
      return {
        status: 'pending',
        shouldUpdate: true,
        newSnapshotFields: {
          status: 'pending',
          recovered_at: nowIso,
          failed_at: undefined,
          recovery_strikes: 0,
          recovery_strike_at: undefined,
          verdict_method: undefined,
        },
      };
    }
    // First confirming window — stamp recovery_strike_at so the strike-2 Wilson
    // window anchors here (independent from strike-1's window). Required for the
    // α² K=2 false-promote guarantee (symmetric with drift_strike_at).
    return {
      status: 'failed',
      shouldUpdate: true,
      newSnapshotFields: {
        status: 'failed',
        recovery_strikes: nextStrikes,
        recovery_strike_at: new Date(nowMs).toISOString(),
      },
    };
  }

  // Non-confirming window → reset strikes. No prior strike means steady-state
  // (nothing to write); a prior strike must be cleared.
  if ((snapshot.recovery_strikes ?? 0) === 0) {
    return { status: 'failed', shouldUpdate: false };
  }
  return {
    status: 'failed',
    shouldUpdate: true,
    newSnapshotFields: {
      status: 'failed',
      recovery_strikes: 0,
      recovery_strike_at: undefined,
    },
  };
}

function resolveDriftDemotedFastPath(
  snapshot: SkillSnapshot,
  driftDelta: CategoryCounters | undefined,
  _nowMs: number,
): VerdictResult | null {
  if (!driftDelta) return null;
  if (snapshot.passed_baseline_rate == null) return null;
  const postTotal = driftDelta.correct + driftDelta.hallucinated;
  if (postTotal < DRIFT_WINDOW_SIZE) return null;
  const fails = wilsonLowerBoundFailsAgainst(
    driftDelta,
    postTotal,
    snapshot.passed_baseline_rate,
  );
  if (!fails) return null;
  return {
    status: 'silent_skill',
    shouldUpdate: true,
    newSnapshotFields: { status: 'silent_skill' },
  };
}
