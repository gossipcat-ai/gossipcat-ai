/**
 * Shared sanitizer for agent-controlled strings before they reach log output,
 * JSONL rows, or are interpolated into downstream prompt text.
 *
 * Design choices:
 *  - Control chars (U+0000–U+001F, U+007F) except \t (\x09) and \n (\x0A) are
 *    replaced with U+FFFD (REPLACEMENT CHARACTER). This makes the substitution
 *    visible in log readers while clearly marking tampered input, unlike
 *    silently stripping or hex-encoding. \t and \n are kept because they are
 *    structurally meaningful in both log lines and ANSI-aware terminals.
 *  - Length is capped with a trailing '…' so a single crafted field cannot
 *    flood stderr or a JSONL row.
 */

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Sanitize an agent-supplied string for safe interpolation into log messages,
 * JSONL fields, or prompt text.
 *
 * @param raw     The untrusted string.
 * @param maxChars Maximum character length before truncation (default 200).
 */
export function sanitizeForLog(raw: string, maxChars = 200): string {
  let s = raw.replace(CONTROL_CHAR_RE, '�');
  if (s.length > maxChars) {
    s = s.slice(0, maxChars) + '…';
  }
  return s;
}
