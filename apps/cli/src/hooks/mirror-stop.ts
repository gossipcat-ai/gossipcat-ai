/**
 * `gossipcat hook mirror-stop` — Stop mirror hook.
 *
 * Reads `{transcript_path, session_id}` from stdin. Opens the transcript JSONL
 * and scans BACKWARD for the last `assistant` entry that contains a
 * `type==='text'` content block, then POSTs that text as a `role:'assistant'`
 * mirror frame.
 *
 * Probe fact Q2 + sonnet:f5/f6/f10:
 *   - Transcript JSONL = one JSON object per line. Assistant entries carry a
 *     content array of blocks: `text` / `thinking` / `tool_use`. `tool_result`
 *     lives in `user` entries, so it is naturally excluded by only reading
 *     `assistant` entries.
 *   - ALLOWLIST `text` blocks — skip `thinking` (private reasoning) and
 *     `tool_use` (structured calls). A pure-tool-use / malformed / missing final
 *     turn → send NOTHING (gemini:f1/f3 — fail-open to silence on parse error).
 *
 * Fail-open: any error → no POST, exit 0.
 */
import { readFileSync } from 'fs';
import { readStdin, parsePayload, resolveCwd, postMirror } from './mirror-shared';
import { scrubSecrets, truncate } from './mirror-scrub';

/** Assistant-text cap (under the relay's MIRROR_MAX_TEXT ≈ 2KB hard bound). */
const ASSISTANT_TEXT_CAP = 2000;
/** Don't read transcripts larger than this into memory (bounded fail-open). */
const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Extract the last assistant `text` block from transcript JSONL content.
 *
 * Scans lines from the END (the final assistant turn is what the user just saw)
 * and returns the concatenated `text` blocks of the FIRST `assistant` entry
 * (walking backward) that has at least one. Returns null when no such entry
 * exists (pure-tool-use final turn, thinking-only, malformed, or empty).
 *
 * Exported for unit testing without disk IO.
 */
export function extractLastAssistantText(jsonl: string): string | null {
  if (typeof jsonl !== 'string' || jsonl.length === 0) return null;
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip a malformed line, keep scanning backward
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;

    // The role lives either at `.type` (top-level) or `.message.role`
    // (nested message envelope). Accept both shapes; only `assistant` matters.
    const role = resolveEntryRole(e);
    if (role !== 'assistant') continue;

    const content = resolveEntryContent(e);
    if (!Array.isArray(content)) continue;

    // ALLOWLIST: collect ONLY type==='text' blocks. thinking / tool_use skipped.
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          texts.push(b['text']);
        }
      }
    }
    // No text blocks in this assistant entry (tool-use-only / thinking-only) —
    // keep scanning backward; an earlier assistant turn may carry the text.
    if (texts.length === 0) continue;
    const joined = texts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/** Resolve an entry's role across the two known transcript shapes. */
function resolveEntryRole(e: Record<string, unknown>): string | null {
  if (typeof e['type'] === 'string' && (e['type'] === 'assistant' || e['type'] === 'user')) {
    return e['type'];
  }
  const msg = e['message'];
  if (msg && typeof msg === 'object') {
    const r = (msg as Record<string, unknown>)['role'];
    if (typeof r === 'string') return r;
  }
  const r = e['role'];
  return typeof r === 'string' ? r : null;
}

/** Resolve an entry's content-block array across the two known shapes. */
function resolveEntryContent(e: Record<string, unknown>): unknown {
  if (Array.isArray(e['content'])) return e['content'];
  const msg = e['message'];
  if (msg && typeof msg === 'object') {
    return (msg as Record<string, unknown>)['content'];
  }
  return undefined;
}

/** Hook body. */
export async function runMirrorStopHook(rawStdin?: string): Promise<void> {
  try {
    const raw = rawStdin ?? (await readStdin());
    const payload = parsePayload(raw);
    if (!payload) return;

    const transcriptPath = payload['transcript_path'];
    if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return;

    let jsonl: string;
    try {
      jsonl = readFileSync(transcriptPath, 'utf8');
    } catch {
      return; // missing / unreadable transcript → send nothing
    }
    if (jsonl.length > TRANSCRIPT_MAX_BYTES) return; // pathological — fail-open silent

    const text = extractLastAssistantText(jsonl);
    if (text === null) return; // pure-tool-use / malformed final turn → send nothing

    const cwd = resolveCwd(payload['cwd']);
    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : undefined;
    // Scrub defensively (assistant text could echo a secret it was shown) + cap.
    const safe = truncate(scrubSecrets(text), ASSISTANT_TEXT_CAP);

    postMirror({ cwd, sessionId, frames: [{ role: 'assistant', text: safe }] });
  } catch {
    // fail-open
  }
}
