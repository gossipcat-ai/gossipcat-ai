/**
 * On-demand skill fetch — shared shape for the relay `skill_query` worker tool
 * and the native `gossip_skill_query` MCP tool (issue #715 / #698 part 2).
 *
 * Both runtimes must return byte-identical payloads for the same skill so that
 * an agent's citation of a skill roundtrips regardless of how it was dispatched.
 * The header mirrors `gossip_skills(action: "get")`.
 *
 * Neither resolution NOR the quarantine gate lives here — both stay in
 * `@gossip/orchestrator`'s `resolveServableSkill`, which owns the agent-id
 * regex, `normalizeSkillName`, the base-directory containment check, and the
 * effectiveness/kill-switch filters shared with `loadSkills`. This module only
 * formats what that resolver returned, so there is no second path-joining or
 * second policy surface to get wrong.
 *
 * IRON RULE: the caller's RAW skill argument never appears in output. It is
 * attacker-controlled and would otherwise land verbatim in a markdown header
 * (forging a second heading / injecting newlines) and in a JSONL audit field.
 * Everything echoed is the CANONICAL normalized name.
 */

import { truncateToBytes } from './truncate';

/**
 * Byte cap on the TOTAL returned payload — header + body + truncation marker.
 * Skill files are prompt material (the largest bundled default is a few KB), so
 * 16KB is generous while still bounding a hand-authored runaway file. Marker
 * matches the verifier-tool convention in consensus-engine.ts.
 */
export const SKILL_QUERY_MAX_BYTES = 16 * 1024;

const TRUNCATION_MARKER = '\n…[truncated]';

/** Resolution result shape returned by `resolveServableSkill`. */
export interface ResolvedSkillLike {
  content: string;
  path: string;
}

/**
 * Outcome of an on-demand lookup. `skill: null` covers BOTH "no such file" and
 * "quarantined" — the caller renders one indistinguishable not-found message so
 * an agent cannot probe which of its skills were suppressed.
 */
export interface SkillQueryResolution {
  canonicalName: string;
  skill: ResolvedSkillLike | null;
}

/**
 * Resolver callback injected from the MCP boot path so `packages/tools` does
 * not have to import `@gossip/orchestrator` (which would create a circular
 * dependency — same reasoning as `MemorySearcherLike`).
 */
export type SkillResolverLike = (
  agentId: string,
  skill: string,
) => SkillQueryResolution;

/**
 * Format a resolved skill as the tool response body.
 *
 * The body budget is the cap MINUS the header and marker, so the wire payload
 * never exceeds SKILL_QUERY_MAX_BYTES. (A pathologically long resolved path
 * could in principle consume the whole budget; the body is then empty rather
 * than the header being cut, since a truncated header would misattribute the
 * content. Path length is bounded by the filesystem, not by the caller.)
 */
export function formatSkillPayload(canonicalName: string, resolved: ResolvedSkillLike): string {
  const header = `# skill: ${canonicalName}  (resolved: ${resolved.path})\n\n`;
  const headerBytes = Buffer.byteLength(header, 'utf8');
  if (Buffer.byteLength(resolved.content, 'utf8') <= SKILL_QUERY_MAX_BYTES - headerBytes) {
    return header + resolved.content;
  }
  const budget = SKILL_QUERY_MAX_BYTES - headerBytes - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  if (budget <= 0) return header + TRUNCATION_MARKER;
  return header + truncateToBytes(resolved.content, budget) + TRUNCATION_MARKER;
}

/**
 * Format the not-found response, naming every scope that was searched. Echoes
 * the CANONICAL name only. A raw argument that normalizes to nothing renders as
 * `<invalid>` rather than being reflected back.
 */
export function formatSkillNotFound(canonicalName: string, agentId: string): string {
  const shown = canonicalName || '<invalid>';
  return `Skill "${shown}" not found. Searched: agent-local (.gossip/agents/${agentId}/skills), project-wide (.gossip/skills), and bundled (default-skills).`;
}
