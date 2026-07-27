/**
 * Phase-2 cross-review skill injection: the severity gate + the single shared
 * resolver that turns an agent's configured skills into prompt content.
 *
 * Issue #666. Injecting every reviewer's skill files into every cross-review
 * prompt costs ~43KB/agent/round. That price is worth paying when the round is
 * verifying a critical/high-severity finding and is not worth paying otherwise,
 * so `crossReviewSkillGateSeverity` computes a mechanical gate from the Phase-1
 * findings under review and callers omit `getAgentSkillsContent` entirely when
 * the gate is closed.
 *
 * `createAgentSkillsContentResolver` is deliberately the ONLY adapter from
 * `loadSkills` to `ConsensusEngineConfig.getAgentSkillsContent` (HANDBOOK
 * invariant #7 — one filter site). Every construction site that wants skills on
 * cross-review must go through it so the agent-local → project-wide → bundled
 * resolution order stays identical everywhere.
 */

import type { SkillIndex } from './skill-index';
import { loadSkills } from './skill-loader';

/** Severities that open the cross-review skill gate. */
export type CrossReviewSkillGateSeverity = 'critical' | 'high';

/**
 * Minimal shape the gate reads. `ParsedFinding` from `parse-findings` satisfies
 * it, but the gate never depends on the rest of that record so it stays a pure
 * `findings[] → verdict` function that is trivial to unit-test.
 */
export interface SeverityBearingFinding {
  severity?: unknown;
}

/**
 * Highest gate-opening severity present in `findings`, or `null` when none is.
 *
 * Fail-closed by construction: only the canonical lowercase enum emitted by
 * `parseAgentFindingsStrict` (`critical` / `high`) opens the gate. Anything else
 * — `undefined`, `'HIGH'`, `'sev:high'`, a number, a null entry, a non-array
 * argument — is treated as non-triggering rather than coerced.
 */
export function crossReviewSkillGateSeverity(
  findings: readonly SeverityBearingFinding[] | null | undefined,
): CrossReviewSkillGateSeverity | null {
  if (!Array.isArray(findings)) return null;

  let sawHigh = false;
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const severity = (finding as SeverityBearingFinding).severity;
    if (severity === 'critical') return 'critical';
    if (severity === 'high') sawHigh = true;
  }
  return sawHigh ? 'high' : null;
}

/** True when at least one finding under review is `critical` or `high`. */
export function shouldInjectCrossReviewSkills(
  findings: readonly SeverityBearingFinding[] | null | undefined,
): boolean {
  return crossReviewSkillGateSeverity(findings) !== null;
}

export interface AgentSkillsContentResolverConfig {
  /** Registry lookup returning the agent's configured skill names. */
  registryGet: (agentId: string) => { skills?: string[] } | null | undefined;
  projectRoot: string;
  /**
   * Read lazily on every call — the skill index is often installed after the
   * owning object is constructed, so a snapshot taken at factory time would
   * permanently resolve to `undefined`.
   */
  getSkillIndex?: () => SkillIndex | null | undefined;
}

/**
 * Build the `getAgentSkillsContent` callback consumed by `ConsensusEngine`.
 * Returns `undefined` (no skills block) on any resolution failure — skill
 * injection is best-effort and must never abort a consensus round.
 */
export function createAgentSkillsContentResolver(
  config: AgentSkillsContentResolverConfig,
): (agentId: string, task: string) => string | undefined {
  return (agentId: string, task: string): string | undefined => {
    try {
      const agentSkills = config.registryGet(agentId)?.skills || [];
      const index = config.getSkillIndex?.() ?? undefined;
      return loadSkills(agentId, agentSkills, config.projectRoot, index, task).content || undefined;
    } catch {
      return undefined;
    }
  };
}
