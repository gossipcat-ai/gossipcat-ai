/**
 * Memory taxonomy mapper — display-side remap of Claude Code's auto-memory
 * 5-type schema (`user / feedback / project / reference / session`) onto the
 * 4-folder dashboard view (Backlog / Record / Session / Rule).
 *
 * Why a remap exists:
 * - Claude Code owns the write-side schema; we cannot change it.
 * - 100% of `session_*` files drift to `type: project` in frontmatter, so
 *   filename prefix is a more reliable signal than declared type.
 * - `project_*` lumps open backlog (needs `gossip_verify_memory`) with shipped
 *   records (reference-only). The optional `status` frontmatter field splits
 *   them: only `shipped` and `closed` graduate a project memory to `record`.
 *
 * Spec: docs/specs/2026-04-15-memory-taxonomy-hybrid.md
 */

export type DisplayType = 'backlog' | 'record' | 'session' | 'rule';

export interface Memory {
  filename: string;
  frontmatter?: { type?: string; status?: string };
  content: string;
}

/**
 * Status values that mark a project memory as "shipped/read-only" (record).
 * Anything not in this set — including unknown values like `blocked`,
 * `archived`, or missing — falls through to `backlog`. This is intentional:
 * keep ambiguous items VISIBLE rather than hiding them under an unfamiliar
 * folder where a user might miss stale work.
 */
const RECORD_STATUSES = new Set(['shipped', 'closed']);

/**
 * Map a memory file to its display folder.
 *
 * Resolution order:
 *   1. MEMORY.md guard — the hand-curated index (no underscore in name) is
 *      always classified as `record`.
 *   2. Filename prefix (lowercased) — authoritative because authors name files
 *      intentionally; frontmatter `type` drifts on copy-paste.
 *   3. Frontmatter `type` (lowercased) — fallback for unusual prefixes.
 *   4. Default → `backlog` (keeps the item visible).
 */
export function toDisplayType(m: Memory): DisplayType {
  // Explicit guard: MEMORY.md is the hand-curated index, not a memory item.
  // It has no underscore, so split('_')[0] would return the whole filename —
  // safer to short-circuit and document the special case.
  if (m.filename === 'MEMORY.md') return 'record';

  const prefix = m.filename.split('_')[0].toLowerCase();
  const fmType = m.frontmatter?.type?.toLowerCase();
  const fmStatus = m.frontmatter?.status?.toLowerCase();

  // Filename prefix is authoritative — it's what the author intended when
  // they named the file. Frontmatter `type` drifts on copy-paste, the
  // filename doesn't.
  if (prefix === 'session') return 'session';
  if (prefix === 'feedback' || prefix === 'user') return 'rule';
  if (prefix === 'project') {
    // Known record statuses → record. Anything else (open, blocked, archived,
    // missing) → backlog. Keeps ambiguous items visible rather than hidden.
    return fmStatus && RECORD_STATUSES.has(fmStatus) ? 'record' : 'backlog';
  }
  if (prefix === 'gossip') return 'record'; // changelogs / agent logs

  // Fallback to frontmatter type for unusual prefixes (case-insensitive).
  if (fmType === 'session') return 'session';
  if (fmType === 'feedback' || fmType === 'user') return 'rule';
  if (fmType === 'reference') return 'record';
  return 'backlog'; // safe default — keeps item visible
}

/**
 * Static metadata for each display folder. Single source of truth for the
 * order, label, and short blurb shown in folder tiles and breadcrumbs.
 */
export const DISPLAY_TYPES: ReadonlyArray<{
  type: DisplayType;
  label: string;
  blurb: string;
}> = [
  { type: 'backlog', label: 'Backlog', blurb: 'Open work, pending decisions' },
  { type: 'record', label: 'Record', blurb: 'Shipped & closed reference' },
  { type: 'session', label: 'Session', blurb: 'Per-session recaps' },
  { type: 'rule', label: 'Rule', blurb: 'Feedback & user preferences' },
];
