import type { SkillIndex } from './skill-index';

/**
 * Permanent skill defaults seeded at MCP boot.
 *
 * These constants and the seeding routine were extracted verbatim from the
 * inline boot block in apps/cli/src/mcp-server-sdk.ts so a test can exercise
 * the SAME constants + suffix-filter the boot path uses (catching a constant
 * typo AND a suffix-filter regression). Behavior is byte-identical to the
 * original inline block.
 */

/** Global permanent defaults — bound to every agent regardless of config. */
export const GLOBAL_PERMANENT_DEFAULTS: readonly string[] = ['memory-retrieval'];

/**
 * Implementer-only permanent defaults — bound to any agent whose id ends in
 * `-implementer`. Convention documented in .claude/rules/gossipcat.md.
 * Spec: docs/specs/2026-04-22-premise-verification.md (Component C).
 */
export const IMPLEMENTER_PERMANENT_DEFAULTS: readonly string[] = [
  'verify-the-premise',
  'implementation-discipline',
];

/**
 * Researcher/Reviewer permanent defaults — bound to any agent whose id ends
 * in `-researcher` or `-reviewer`. Routing is by `endsWith`, so an id matches
 * exactly one trailing suffix: the implementer and researcher/reviewer groups
 * are mutually exclusive. A hybrid-looking id like `foo-researcher-implementer`
 * ends in `-implementer` and routes to the implementer group ONLY.
 * Spec: docs/specs/2026-04-22-premise-verification-stage-2.md (PR B).
 */
export const RESEARCHER_REVIEWER_PERMANENT_DEFAULTS: readonly string[] = [
  'emit-structured-claims',
];

/**
 * Pure seeding routine. Binds the global, implementer, and researcher/reviewer
 * permanent defaults to the matching agent ids via
 * `skillIndex.ensureBoundWithMode(..., 'permanent')`, which is idempotent.
 *
 * NO try/catch and NO logging here — the caller logs per group and handles
 * errors fail-soft. Returns the agent-id groups that were targeted so the
 * caller can emit accurate counts.
 */
export function seedPermanentDefaults(
  skillIndex: SkillIndex,
  agentIds: readonly string[],
): { global: string[]; implementer: string[]; researcherReviewer: string[] } {
  const allAgentIds = agentIds.filter(
    (id) => typeof id === 'string' && id.length > 0,
  );
  if (allAgentIds.length > 0) {
    skillIndex.ensureBoundWithMode([...GLOBAL_PERMANENT_DEFAULTS], allAgentIds, 'permanent');
  }
  const implementer = allAgentIds.filter((id) => id.endsWith('-implementer'));
  if (implementer.length > 0) {
    skillIndex.ensureBoundWithMode([...IMPLEMENTER_PERMANENT_DEFAULTS], implementer, 'permanent');
  }
  const researcherReviewer = allAgentIds.filter(
    (id) => id.endsWith('-researcher') || id.endsWith('-reviewer'),
  );
  if (researcherReviewer.length > 0) {
    skillIndex.ensureBoundWithMode(
      [...RESEARCHER_REVIEWER_PERMANENT_DEFAULTS],
      researcherReviewer,
      'permanent',
    );
  }
  return { global: allAgentIds, implementer, researcherReviewer };
}
