/**
 * Reserved-agent-id guard — spec 2026-04-19-gossip-remember-hardening Part 5.
 *
 * `_project` is an allowed public-memory sentinel. Every other underscore-prefix
 * id is reserved to keep `_system` / `_audit` / `_admin` etc. free from
 * spoofing. Also blocks JS-prototype booby-traps.
 *
 * Applied at BOTH gossip_setup (creation) and gossip_remember (query).
 *
 * Extracted into its own module so tests can import it without pulling in the
 * full MCP server boot (stderr redirection + side effects at module load).
 */

const RESERVED_AGENT_ID_LITERALS = new Set(['__proto__', 'constructor', 'prototype']);

export function isReservedAgentId(id: string): boolean {
  if (id === '_project') return false; // public memory — allowed everywhere
  if (RESERVED_AGENT_ID_LITERALS.has(id)) return true;
  return /^_/.test(id);
}
