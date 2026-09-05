/**
 * Shared byte-safe truncation helper for tool outputs.
 *
 * Lives in its own module because two independent tool paths need it —
 * `file_read` (tool-server) and `skill_query` (skill-query) — and importing it
 * across those two would create a module cycle.
 */

/**
 * Single source of truth for the "this payload was cut" marker. Any path that
 * truncates tool output (skill_query, the consensus-engine verifier tool-call
 * loop) should append exactly this string so a downstream re-truncation can
 * detect an already-truncated payload instead of blindly re-slicing it and
 * mangling the marker (#731).
 */
export const TRUNCATION_MARKER = '\n…[truncated]';

/**
 * Truncate text so its UTF-8 byte length stays <= maxBytes, without splitting
 * a multi-byte character. Prefers cutting at the last newline in the second
 * half of the slice so the returned string ends at a clean line boundary.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Slice to maxBytes, then decode — the subarray may end mid-char, but
  // TextDecoder with fatal:false replaces the incomplete sequence with U+FFFD.
  let slice = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  // Strip any trailing replacement character left by the incomplete sequence.
  // Use the \uFFFD escape (not a literal char) so a build/encoding transform
  // can't silently break the strip and let the result exceed maxBytes.
  slice = slice.replace(/\uFFFD$/, '');
  // Prefer cutting at a newline in the latter half of the slice to avoid
  // dropping a large chunk of content due to an early newline.
  const midpoint = Math.floor(slice.length / 2);
  const lastNl = slice.lastIndexOf('\n');
  if (lastNl > midpoint) slice = slice.slice(0, lastNl);
  return slice;
}

/**
 * Truncate a verifier tool-call result (file_read / file_grep / skill_query,
 * etc.) so it fits within `maxBytes`, byte-aware and idempotent against
 * re-truncation.
 *
 * If `out` already ends with `TRUNCATION_MARKER` (e.g. skill_query already
 * truncated its own output at its byte cap), the existing marker is stripped
 * before re-cutting so the result carries exactly one truncation notice
 * instead of a clipped/duplicated one. Byte-aware via `truncateToBytes` so
 * multi-byte UTF-8 sequences are never split mid-character.
 *
 * This is the single source of truth for verifier tool-result truncation —
 * every call site that trims a tool result before handing it back to a
 * reviewer LLM must go through this function instead of hand-rolling its own
 * cap, or the two copies silently drift apart (#731, reintroduced via a
 * second hand-rolled loop and fixed again in #749).
 */
export function truncateVerifierToolResult(out: string, maxBytes: number): string {
  if (Buffer.byteLength(out, 'utf8') <= maxBytes) return out;
  const base = out.endsWith(TRUNCATION_MARKER) ? out.slice(0, -TRUNCATION_MARKER.length) : out;
  const budget = maxBytes - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  return budget > 0 ? truncateToBytes(base, budget) + TRUNCATION_MARKER : TRUNCATION_MARKER;
}
