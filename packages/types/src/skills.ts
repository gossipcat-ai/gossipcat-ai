/**
 * Skills API shared types — used by both the relay (api-skills.ts) and the
 * dashboard-v2 client. Canonical home is @gossip/types so both packages share
 * one definition and avoid type drift.
 */

/** Effectiveness verdict for a bound skill — matches orchestrator SkillStatus union. */
export type SkillVerdict =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'silent_skill'
  | 'insufficient_evidence'
  | 'inconclusive'
  | 'flagged_for_manual_review';

/**
 * Alias for SkillVerdict kept for dashboard-v2 backward compatibility.
 * dashboard-v2/src/lib/types.ts re-exported this as SkillStatus before the hoist.
 */
export type SkillStatus = SkillVerdict;

/** One point on the post-bind effectiveness curve for a single skill. */
export interface SkillCurvePoint {
  /** Window-end timestamp (ms epoch). */
  t: number;
  /** Accuracy in window = correct / (correct + hallucinated). null when window empty. */
  value: number | null;
}

/** Per-agent+skill effectiveness curve plus graduation metadata. */
export interface SkillEffectivenessEntry {
  agentId: string;
  skill: string;
  status: SkillVerdict | null;
  /** 10 equal-time windows from boundAt → now. */
  curve: SkillCurvePoint[];
  /** Graduation threshold — passed_baseline_rate from frontmatter, fallback 0.7. */
  threshold: number;
  /** Total post-bind signals across the full curve window. */
  n: number;
  /** ISO. Anchor for the curve. */
  boundAt: string;

  // ── Verdict provenance fields (issue #571 fix) ───────────────────────────
  /**
   * The stored effectiveness delta from frontmatter (the value the verdict was
   * actually based on). Distinct from the live 7d trailing rate in the curve.
   * Frontmatter field: `effectiveness`.
   */
  storedEffectiveness?: number;
  /**
   * Best-available "verdict as of" ISO timestamp from frontmatter.
   * Checked in order: passed_at → inconclusive_at → regressed_from_passed_at → bound_at.
   * Undefined when no timestamp field is present in frontmatter.
   */
  verdictAt?: string;
  /**
   * True when the frozen verdict is 'failed' or 'silent_skill' AND the live 7d
   * window shows recovery: n > 0 AND trailing rate >= threshold. Signals skills
   * that have recovered since the verdict was recorded (see issue #572).
   */
  liveRecovered?: boolean;
}

/**
 * Response shape for GET /api/skills — served by relay, consumed by dashboard-v2.
 * Renamed from SkillsGetResponse (relay) and SkillsApiResponse (dashboard) to
 * a single canonical name.
 */
export interface SkillsApiResponse {
  /** Raw skill-index passthrough (agent → skill → slot). */
  index: Record<string, Record<string, unknown>>;
  suggestions: string[];
  /** Per-agent+skill effectiveness curves. Drives SkillGraduationGrid. */
  effectiveness: SkillEffectivenessEntry[];
}

/**
 * Alias kept for relay backward compat — relay's handler still returns SkillsGetResponse.
 * @deprecated Use SkillsApiResponse directly.
 */
export type SkillsGetResponse = SkillsApiResponse;
