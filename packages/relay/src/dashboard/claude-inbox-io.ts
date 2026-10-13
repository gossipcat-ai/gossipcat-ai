/**
 * claude-inbox-io.ts — small, bounded file primitives shared by the durable
 * Claude inbox (claude-inbox.ts), its watcher heartbeat
 * (claude-inbox-watcher.ts) and the reply outbox (bridge-reply-outbox.ts).
 *
 * Every reader here stats BEFORE reading and refuses files over a caller cap,
 * so a planted multi-GB file under .gossip/bridge can't OOM the relay or a hook.
 */

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';

/** Write `data` to `path` atomically with mode 0600 (unique tmp + rename). */
export function atomicWrite0600(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** Result of a bounded read: parsed JSON, `oversized`, or `null` (missing / not a file / bad JSON). */
export type BoundedJson = { value: unknown } | 'oversized' | null;

/** Stat first, then read + JSON.parse only when the file is at most `maxBytes`. */
export function readJsonBounded(path: string, maxBytes: number): BoundedJson {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    if (st.size > maxBytes) return 'oversized';
    return { value: JSON.parse(readFileSync(path, 'utf-8')) as unknown };
  } catch {
    return null;
  }
}

/** Strict `YYYY-MM-DDTHH:mm:ss.sssZ` — exactly what Date#toISOString emits. */
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True only for a canonical ISO-8601 UTC timestamp that round-trips through
 * Date (rejects `2026-02-31…`, offsets, extra text, injected newlines).
 */
export function isCanonicalIso(v: unknown): v is string {
  if (typeof v !== 'string' || !CANONICAL_ISO_RE.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === v;
}
