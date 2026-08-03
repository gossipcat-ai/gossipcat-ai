/**
 * Shared byte-safe truncation helper for tool outputs.
 *
 * Lives in its own module because two independent tool paths need it —
 * `file_read` (tool-server) and `skill_query` (skill-query) — and importing it
 * across those two would create a module cycle.
 */

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
