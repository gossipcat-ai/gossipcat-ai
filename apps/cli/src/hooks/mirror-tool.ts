/**
 * `gossipcat hook mirror-tool` — PostToolUse mirror hook.
 *
 * Reads `{tool_name, tool_input, tool_response, session_id}` from stdin and, for
 * a CURATED allowlist of tools ONLY (Bash, Edit, Write, gossip_dispatch/run/
 * collect — NOT Read/Grep, deepseek:f8 flood), POSTs a `role:'activity'` mirror
 * frame containing a scrubbed one-liner derived from `tool_input`.
 *
 * Security (§Security P0):
 *   - NEVER forward `tool_response` (verified arg-exfil risk — the response can
 *     carry whole file contents / command output).
 *   - Scrub `tool_input` for secrets (Bearer / --password / api_key= / secret
 *     env-vars / long hex-base64) BEFORE truncating to ~80 chars.
 *
 * Fail-open: any error / non-allowlisted tool → no POST, exit 0.
 */
import { readStdin, parsePayload, resolveCwd, postMirror } from './mirror-shared';
import { buildActivityLine } from './mirror-scrub';

/** Hook body. */
export async function runMirrorToolHook(rawStdin?: string): Promise<void> {
  try {
    const raw = rawStdin ?? (await readStdin());
    const payload = parsePayload(raw);
    if (!payload) return;

    // buildActivityLine reads ONLY tool_name + tool_input; tool_response is
    // never passed in. Non-allowlisted tool → null → no POST.
    const line = buildActivityLine(payload['tool_name'], payload['tool_input']);
    if (line === null) return;

    const cwd = resolveCwd(payload['cwd']);
    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : undefined;

    postMirror({ cwd, sessionId, frames: [{ role: 'activity', text: line }] });
  } catch {
    // fail-open
  }
}
