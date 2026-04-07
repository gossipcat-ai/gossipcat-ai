/**
 * Pure functions for skill effectiveness evaluation.
 *
 * Statistical foundation:
 *   - One-sided z-test on per-category accuracy = correct / (correct + hallucinated)
 *   - Two simultaneous tests (passed-direction, failed-direction) → Bonferroni α=0.025 each
 *   - Evidence gate: ≥ MIN_EVIDENCE category-tagged signals since last snapshot
 *   - Power: ≥ 80% for detecting +10pp shift at p=0.75 baseline (see spec power table)
 */

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
  baseline_correct: number;
  baseline_hallucinated: number;
  bound_at: string; // ISO timestamp
  status: VerdictStatus;
  migration_count: number;
  inconclusive_correct?: number;
  inconclusive_hallucinated?: number;
  inconclusive_at?: string;
  inconclusive_strikes?: number;
}

export interface CategoryCounters {
  correct: number;
  hallucinated: number;
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
  current: CategoryCounters,
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

  // Effective baseline = the most recent snapshot (inconclusive epoch wins if present)
  const effBaselineCorrect = snapshot.inconclusive_correct ?? snapshot.baseline_correct;
  const effBaselineHallucinated = snapshot.inconclusive_hallucinated ?? snapshot.baseline_hallucinated;

  // Post-window deltas
  const deltaCorrect = current.correct - effBaselineCorrect;
  const deltaHallucinated = current.hallucinated - effBaselineHallucinated;
  const postTotal = deltaCorrect + deltaHallucinated;

  const effBaselineTotal = effBaselineCorrect + effBaselineHallucinated;
  const baselineP = effBaselineTotal > 0 ? effBaselineCorrect / effBaselineTotal : 0.5;

  // Defensive: signal expiry can produce negative deltas if the baseline was
  // snapshotted before signals expired from the 30-day window in performance-reader.
  // A negative postTotal is a semantic error, not "not enough data" — return pending
  // without writing snapshot fields so the next round (after baseline catches up) re-evaluates.
  // TODO: root fix is to snapshot delta-from-bind instead of cumulative counters.
  if (postTotal < 0) {
    return { status: 'pending', shouldUpdate: false };
  }

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
  const positive = oneSidedZTest({ correct: deltaCorrect, total: postTotal }, baselineP, 'positive');
  const negative = oneSidedZTest({ correct: deltaCorrect, total: postTotal }, baselineP, 'negative');
  const postP = deltaCorrect / postTotal;
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
      inconclusive_correct: current.correct,
      inconclusive_hallucinated: current.hallucinated,
      inconclusive_at: new Date(nowMs).toISOString(),
      inconclusive_strikes: strikes,
    },
  };
}
