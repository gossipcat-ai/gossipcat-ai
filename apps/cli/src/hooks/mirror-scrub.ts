/**
 * Argument scrubbing + role types for the activity-mirror hooks (spec §Security
 * "Argument scrubbing (P0)" + §Consensus-hardening sonnet:f8).
 *
 * The PostToolUse hook forwards a one-liner summary of `tool_input` to the
 * dashboard — NEVER `tool_response`. That input may contain secrets (a `curl`
 * with a Bearer token, an `export API_KEY=…`, an inline credential). We scrub
 * the FULL string FIRST (so a secret near the end isn't missed by an early
 * truncate), THEN truncate to ~80 chars (sonnet:f8: scrub-then-truncate).
 */

/** Strict mirror role enum — mirrors the relay's MIRROR_ROLES (api-bridge.ts). */
export const MIRROR_ROLES = ['user', 'assistant', 'activity'] as const;
export type MirrorRole = (typeof MIRROR_ROLES)[number];

/** Redaction marker substituted in place of a matched secret. */
export const REDACTED = '«redacted»';

/** One-liner summary length cap (after scrubbing). */
export const SCRUB_SUMMARY_MAX = 80;

/**
 * Secret patterns, applied in order over the FULL string before truncation.
 * Each replaces the secret token with REDACTED, preserving the surrounding
 * structure so the activity line still reads sensibly.
 *
 *   - Bearer tokens:        `Bearer <token>`
 *   - --password flags:     `--password <val>` / `--password=<val>`
 *   - api key assignments:  `api_key=<val>` / `api-key=<val>` / `apikey=<val>`
 *   - secret env vars:      `FOO_KEY=…` / `FOO_SECRET=…` / `FOO_TOKEN=…` / `FOO_PASSWORD=…`
 *   - long hex / base64:    a standalone ≥32-char hex or base64-ish run
 *
 * Ordering matters: env-var / api-key assignments run before the bare
 * hex/base64 sweep so the whole `KEY=value` is collapsed to `KEY=«redacted»`
 * rather than leaving a dangling `KEY=` with the value separately redacted.
 */
const SCRUB_PATTERNS: Array<{ re: RegExp; replace: (m: string, ...g: string[]) => string }> = [
  // Bearer <token>
  { re: /Bearer\s+\S+/gi, replace: () => `Bearer ${REDACTED}` },
  // --password <val> or --password=<val>
  { re: /(--password[=\s]+)\S+/gi, replace: (_m, p1: string) => `${p1.trimEnd()}=${REDACTED}` },
  // api_key= / api-key= / apikey=  (value to next whitespace)
  { re: /(api[_-]?key\s*=\s*)\S+/gi, replace: (_m, p1: string) => `${p1}${REDACTED}` },
  // secret-bearing env-var assignments: NAME_(KEY|SECRET|TOKEN|PASSWORD)=value
  {
    re: /([A-Z][A-Z0-9_]*_(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*)\S+/g,
    replace: (_m, p1: string) => `${p1}${REDACTED}`,
  },
  // JWTs: three base64url segments joined by dots, header always starts `eyJ`.
  // MUST run before the ≥32 sweep — each segment can be <32 chars (so the bare
  // sweep misses it) and the `.` separator is not in that sweep's char class
  // (consensus 4a4b2087 HIGH: bare-JWT bypass).
  { re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replace: () => REDACTED },
  // Long hex or base64-ish run (≥32 chars) standing alone. Word-bounded so we
  // don't shred normal prose; the env/api sweeps above already handled
  // KEY=value cases.
  { re: /\b[A-Za-z0-9+/=_-]{32,}\b/g, replace: () => REDACTED },
];

/**
 * Scrub secrets from `input` (the FULL string) without truncating. Always
 * returns a single-line string (newlines/whitespace collapsed to single spaces).
 * This is the load-bearing security primitive: scrubbing the full string means
 * a secret near the end is redacted BEFORE any caller truncates (sonnet:f8 —
 * scrub-then-truncate, never truncate-then-scrub).
 */
export function scrubSecrets(input: string): string {
  if (typeof input !== 'string') return '';
  let s = input;
  for (const { re, replace } of SCRUB_PATTERNS) {
    s = s.replace(re, replace as (substring: string, ...args: any[]) => string);
  }
  // Collapse whitespace/newlines into single spaces — mirror rows are one line.
  return s.replace(/\s+/g, ' ').trim();
}

/** Truncate an already-single-line string to `max` with an ellipsis. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Scrub secrets from `input`, THEN truncate to `SCRUB_SUMMARY_MAX` (the activity
 * one-liner cap). Scrub-first is load-bearing — see `scrubSecrets`.
 */
export function scrubAndTruncate(input: string): string {
  return truncate(scrubSecrets(input), SCRUB_SUMMARY_MAX);
}

/**
 * Curated PostToolUse allowlist (spec §Component 1 PostToolUse + deepseek:f8 —
 * NOT every Read/Grep, which would flood the activity stream). Only these tools
 * produce an activity frame.
 */
export const ACTIVITY_TOOL_ALLOWLIST = new Set<string>([
  'Bash',
  'Edit',
  'Write',
  'mcp__gossipcat__gossip_dispatch',
  'mcp__gossipcat__gossip_run',
  'mcp__gossipcat__gossip_collect',
]);

/**
 * Build the scrubbed one-liner for an allowlisted tool. Returns null when the
 * tool is NOT on the allowlist (caller sends nothing). Reads ONLY `tool_input`
 * — `tool_response` is never touched (§Security: never forward tool_response).
 */
export function buildActivityLine(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== 'string' || !ACTIVITY_TOOL_ALLOWLIST.has(toolName)) return null;
  const input = (toolInput && typeof toolInput === 'object') ? (toolInput as Record<string, unknown>) : {};

  switch (toolName) {
    case 'Bash': {
      const cmd = typeof input['command'] === 'string' ? input['command'] : '';
      return `🔧 Bash · ${scrubAndTruncate(cmd)}`;
    }
    case 'Edit':
    case 'Write': {
      const fp = typeof input['file_path'] === 'string' ? input['file_path'] : '';
      const verb = toolName === 'Write' ? 'Write' : 'Edit';
      return `✏️ ${verb} · ${scrubAndTruncate(fp)}`;
    }
    case 'mcp__gossipcat__gossip_dispatch':
    case 'mcp__gossipcat__gossip_run': {
      // Best-effort agent extraction; never forward the full task text raw.
      const agent =
        typeof input['agent_id'] === 'string' ? input['agent_id'] :
        typeof input['agent'] === 'string' ? (input['agent'] as string) : '';
      return `📡 dispatch → ${scrubAndTruncate(agent || 'agents')}`;
    }
    case 'mcp__gossipcat__gossip_collect':
      return `📥 collect`;
    default:
      return null;
  }
}
