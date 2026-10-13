/**
 * inbox-fence.ts — pure helpers for fencing untrusted inbox text. Shared by the
 * CLI renderer (apps/cli/src/inbox-format.ts) and the dispatch-time agent mail
 * renderer (agent-mail.ts), so both fence the same way.
 */
import { randomBytes } from 'crypto';

/** Strip C0/C1 control chars (keeps \n and \t) — blocks terminal escape injection. */
export function sanitizeUntrusted(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/**
 * Escape a metadata value for a fence header: anything outside
 * `[A-Za-z0-9_.:-]` becomes `?`, length-capped. Defense in depth — the store
 * already rejects records whose id/chat_id/received_at are malformed.
 */
export function headerSafe(v: string, max = 128): string {
  return String(v).slice(0, max).replace(/[^A-Za-z0-9_.:-]/g, '?');
}

const NONCE_SHORT_TRIES = 8;

/**
 * Pick a fence nonce that does not occur in `texts` (the sanitized body and
 * every header value), so content can never pre-contain the closing marker.
 * Up to NONCE_SHORT_TRIES short nonces, then a 128-bit one.
 */
export function pickNonce(texts: readonly string[], gen: (bytes: number) => string = (n) => randomBytes(n).toString('hex')): string {
  const clashes = (n: string): boolean => texts.some((t) => t.includes(n));
  for (let i = 0; i < NONCE_SHORT_TRIES; i++) {
    const n = gen(4);
    if (!clashes(n)) return n;
  }
  return gen(16);
}
