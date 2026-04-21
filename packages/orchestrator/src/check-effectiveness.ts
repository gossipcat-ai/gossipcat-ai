/**
 * Pure functions for skill effectiveness evaluation.
 *
 * Statistical foundation:
 *   - One-sided z-test on per-category accuracy = correct / (correct + hallucinated)
 *   - Two simultaneous tests (passed-direction, failed-direction) → Bonferroni α=0.025 each
 *   - Evidence gate: ≥ MIN_EVIDENCE category-tagged signals since last snapshot
 *   - Power: ≥ 80% for detecting +10pp shift at p=0.75 baseline (see spec power table)
 */

import type { CategoryCounters } from './performance-reader';
import { wilsonVerdict } from './wilson-score';

export { CategoryCounters };

export const MIN_EVIDENCE = 120;
export const ALPHA = 0.025;
export const Z_CRITICAL = 1.96; // one-sided, α=0.025
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

export interface SkillSnapshot {
  baseline_accuracy_correct: number;
  baseline_accuracy_hallucinated: number;
  bound_at: string; // ISO timestamp
  status: VerdictStatus;
  migration_count: number;
  inconclusive_at?: string;
  inconclusive_strikes?: number;
  verdict_method?: 'z-test' | 'wilson_degenerate';
}

export interface VerdictResult {
  status: VerdictStatus;
  effectiveness?: number; // delta in accuracy (post - baseline)
  zScore?: number;
  verdict_method?: 'z-test' | 'wilson_degenerate';
  shouldUpdate: boolean; // false if terminal state
  newSnapshotFields?: Partial<SkillSnapshot>; // fields to merge into frontmatter
}

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
  if (postTotal < MIN_EVIDENCE) {
    if (timedOut) {
      // If the skill was previously inconclusive, it had activity at some point —
      // a current postTotal===0 means evidence ran dry, not that the skill never fired.
      const everActive = postTotal > 0 || snapshot.inconclusive_at != null;
      const status: VerdictStatus = everActive ? 'insufficient_evidence' : 'silent_skill';
      return {
        status,
        shouldUpdate: true,
        newSnapshotFields: { status },
      };
    }
    return { status: 'pending', shouldUpdate: false };
  }

  // Degenerate-baseline path: z-test cannot reject when baselineP ∈ {0, 1}
  // because se === 0 (zero variance). Wilson score intervals handle this
  // naturally. See docs/specs/2026-04-21-skills-pipeline-repair.md PR 2.
  if (baselineP === 0 || baselineP === 1) {
    const WILSON_ALPHA = 0.025; // matches oneSidedZTest Z_CRITICAL calibration
    const wilson = wilsonVerdict(
      { correct: snapshot.baseline_accuracy_correct, total: baselineTotal },
      { correct: delta.correct, total: postTotal },
      WILSON_ALPHA,
    );
    if (wilson === 'passed' || wilson === 'failed') {
      const postP = delta.correct / postTotal;
      return {
        status: wilson,
        effectiveness: postP - baselineP,
        verdict_method: 'wilson_degenerate',
        shouldUpdate: true,
        newSnapshotFields: { status: wilson, verdict_method: 'wilson_degenerate' },
      };
    }
    // Wilson pending → fall through to standard path
  }

  // Gate met — run both one-sided tests at α=0.025 (Bonferroni)
  const positive = oneSidedZTest({ correct: delta.correct, total: postTotal }, baselineP, 'positive');
  const negative = oneSidedZTest({ correct: delta.correct, total: postTotal }, baselineP, 'negative');
  const postP = delta.correct / postTotal;
  const effectiveness = postP - baselineP;

  if (positive.rejects) {
    return {
      status: 'passed',
      effectiveness,
      zScore: positive.zScore,
      verdict_method: 'z-test',
      shouldUpdate: true,
      newSnapshotFields: { status: 'passed', verdict_method: 'z-test' },
    };
  }
  if (negative.rejects) {
    return {
      status: 'failed',
      effectiveness,
      zScore: negative.zScore,
      verdict_method: 'z-test',
      shouldUpdate: true,
      newSnapshotFields: { status: 'failed', verdict_method: 'z-test' },
    };
  }

  // Inconclusive: write a second snapshot, increment strikes.
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
      shouldUpdate: true,
      newSnapshotFields: { status: 'flagged_for_manual_review', inconclusive_strikes: strikes },
    };
  }
  return {
    status: 'inconclusive',
    effectiveness,
    shouldUpdate: true,
    newSnapshotFields: {
      status: 'inconclusive',
      inconclusive_at: new Date(nowMs).toISOString(),
      inconclusive_strikes: strikes,
    },
  };
}
