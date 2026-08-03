/**
 * On-demand skill fetch — shared shape for the relay `skill_query` worker tool
 * and the native `gossip_skill_query` MCP tool (issue #715 / #698 part 2).
 *
 * Both runtimes must return byte-identical payloads for the same skill so that
 * an agent's citation of a skill roundtrips regardless of how it was dispatched.
 * The header mirrors `gossip_skills(action: "get")` exactly.
 *
 * Resolution itself is NOT performed here — it stays in
 * `@gossip/orchestrator`'s `resolveSkill`, which owns the agent-id regex, the
 * `normalizeSkillName` pass, and the base-directory containment check. This
 * module only formats what that resolver returned, so there is no second
 * path-joining surface to get wrong.
 */

import { truncateToBytes } from './truncate';

/**
 * Byte cap on returned skill markdown. Skill files are prompt material — the
 * largest bundled default is a few KB — so 16KB is generous while still
 * bounding a hand-authored runaway file. Marker matches the verifier-tool
 * convention in consensus-engine.ts (`…[truncated]`).
 */
export const SKILL_QUERY_MAX_BYTES = 16 * 1024;

/** Resolution result shape returned by `resolveSkill` / `resolveSharedSkill`. */
export interface ResolvedSkillLike {
  content: string;
  path: string;
}

/**
 * Resolver callback injected from the MCP boot path so `packages/tools` does
 * not have to import `@gossip/orchestrator` (which would create a circular
 * dependency — same reasoning as `MemorySearcherLike`).
 */
export type SkillResolverLike = (
  agentId: string,
  skill: string,
) => ResolvedSkillLike | null;

/** Format a resolved skill as the tool response body. */
export function formatSkillPayload(skill: string, resolved: ResolvedSkillLike): string {
  const header = `# skill: ${skill}  (resolved: ${resolved.path})\n\n`;
  const body = Buffer.byteLength(resolved.content, 'utf8') > SKILL_QUERY_MAX_BYTES
    ? truncateToBytes(resolved.content, SKILL_QUERY_MAX_BYTES) + '\n…[truncated]'
    : resolved.content;
  return header + body;
}

/** Format the not-found response, naming every scope that was searched. */
export function formatSkillNotFound(skill: string, agentId: string): string {
  return `Skill "${skill}" not found. Searched: agent-local (.gossip/agents/${agentId}/skills), project-wide (.gossip/skills), and bundled (default-skills).`;
}
