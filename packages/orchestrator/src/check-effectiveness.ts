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
}

export interface VerdictResult {
  status: VerdictStatus;
  effectiveness?: number; // delta in accuracy (post - baseline)
  zScore?: number;
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
  const elapsedMs = nowMs - boundAtMs;
  const timedOut = elapsedMs >= TIMEOUT_MS;

  // Pending: not enough evidence yet
  if (postTotal < MIN_EVIDENCE) {
    if (timedOut) {
      return {
        status: postTotal === 0 ? 'silent_skill' : 'insufficient_evidence',
        shouldUpdate: true,
        newSnapshotFields: { status: postTotal === 0 ? 'silent_skill' : 'insufficient_evidence' },
      };
    }
    return { status: 'pending', shouldUpdate: false };
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
      shouldUpdate: true,
      newSnapshotFields: { status: 'passed' },
    };
  }
  if (negative.rejects) {
    return {
      status: 'failed',
      effectiveness,
      zScore: negative.zScore,
      shouldUpdate: true,
      newSnapshotFields: { status: 'failed' },
    };
  }

  // Inconclusive: write a second snapshot, increment strikes
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
