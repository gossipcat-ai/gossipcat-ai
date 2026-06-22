/**
 * `gossipcat hook mirror-prompt` — UserPromptSubmit mirror hook.
 *
 * Reads the CC hook payload `{session_id, transcript_path, cwd, prompt}` from
 * stdin. If the prompt is a DASHBOARD-ORIGIN turn (it carries the channel
 * wrapper `<channel source="gossipcat" chat_id="…">…</channel>`), we SKIP the
 * POST — that turn is already shown in the dashboard; re-mirroring it would
 * duplicate it (probe fact Q1 + sonnet:f10). Otherwise we POST the user's
 * prompt as a `role:'user'` mirror frame.
 *
 * sonnet:f10 — the wrapper match is STRUCTURAL (a leading-tag regex), not a
 * loose `includes('<channel')` substring, so a prompt that merely *mentions*
 * the tag in prose is still mirrored, while a genuine dashboard wrapper is
 * skipped.
 *
 * Fail-open: any parse error / missing field → no POST, exit 0.
 */
import { readStdin, parsePayload, resolveCwd, postMirror } from './mirror-shared';
import { scrubSecrets, truncate } from './mirror-scrub';

/** User-prompt size cap (under the relay's MIRROR_MAX_TEXT ≈ 2KB hard bound). */
const USER_PROMPT_CAP = 1024;

/**
 * Structural match for a dashboard channel wrapper at the START of the prompt.
 * Tolerates leading whitespace and arbitrary attribute order, but requires the
 * `<channel source="gossipcat"` opening token — a structural anchor, not a
 * substring scan.
 */
const CHANNEL_WRAPPER_RE = /^\s*<channel\s+[^>]*\bsource\s*=\s*"gossipcat"/i;

/** Result of inspecting a prompt for the dashboard channel wrapper. */
export interface PromptChannelMatch {
  /** True when the prompt is a dashboard-origin (wrapper-bearing) turn. */
  isDashboardOrigin: boolean;
}

/**
 * Inspect a raw prompt string for the dashboard channel wrapper. We only need
 * the boolean origin verdict — the chat_id is intentionally NOT parsed here:
 * the relay seeds `mirrorChatIds` from its OWN validated inbound POST, never
 * from this hook (P1#1). Parsing it then discarding it was a future footgun
 * (consensus 4a4b2087 f13), so it is removed.
 */
export function inspectPrompt(prompt: unknown): PromptChannelMatch {
  if (typeof prompt !== 'string') return { isDashboardOrigin: false };
  return { isDashboardOrigin: CHANNEL_WRAPPER_RE.test(prompt) };
}

/** Hook body. Resolves once the (detached) POST is dispatched or skipped. */
export async function runMirrorPromptHook(rawStdin?: string): Promise<void> {
  try {
    const raw = rawStdin ?? (await readStdin());
    const payload = parsePayload(raw);
    if (!payload) return; // fail-open

    const prompt = payload['prompt'];
    if (typeof prompt !== 'string' || prompt.length === 0) return;

    const match = inspectPrompt(prompt);
    // Dashboard-origin turns are already rendered — skip (we only learned the
    // chat_id; the relay seeds mirrorChatIds from its OWN validated inbound POST,
    // never from this hook — P1#1).
    if (match.isDashboardOrigin) return;

    const cwd = resolveCwd(payload['cwd']);
    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : undefined;

    // User prompts are the human's own words — mirror them readable, but still
    // secret-scrub defensively (a user might paste a credential) and size-cap
    // under the relay's MIRROR_MAX_TEXT hard bound.
    const text = truncate(scrubSecrets(prompt), USER_PROMPT_CAP);

    postMirror({ cwd, sessionId, frames: [{ role: 'user', text }] });
  } catch {
    // fail-open: never block a turn.
  }
}
