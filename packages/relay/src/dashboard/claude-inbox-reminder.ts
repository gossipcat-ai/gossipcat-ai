/**
 * claude-inbox-reminder.ts — reminder bookkeeping and agent-mail expiry glue
 * for the durable Claude inbox (claude-inbox.ts).
 *
 * Reminder markers are monotonic: reminder n of message <id> is the file
 * `<id>.reminded.<n>` (n = 1..INBOX_MAX_REMINDERS, body {at}), created with
 * O_EXCL and never rewritten or renamed. The current count is the highest n
 * present, so claiming reminder n+1 is a single O_EXCL create: exactly one
 * consumer (hook / watcher) wins it, a racing consumer's create fails, and
 * the count can never regress or reset. A crash after the create leaves a
 * consistent count. The legacy single `<id>.reminded` ({at, count}) marker is
 * still read (count = its count, or 1); new claims continue above it.
 */

import { existsSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isCanonicalIso, readJsonBounded } from './claude-inbox-io';
import { AGENT_MAIL_TTL_MS, isExpirableMail } from './claude-inbox-prune';

/** After this many reminders a message is no longer re-surfaced automatically. */
export const INBOX_MAX_REMINDERS = 6;

/** Reminder bookkeeping of one message (count 0 = never reminded). */
export interface ReminderState {
  at?: string;
  count: number;
}

/** Per-record reminder suffixes: the legacy marker plus `reminded.1` … `reminded.<max>`. */
export const REMINDER_SUFFIXES: readonly string[] = [
  'reminded',
  ...Array.from({ length: INBOX_MAX_REMINDERS }, (_, i) => `reminded.${i + 1}`),
];

const SMALL_FILE_BYTES = 4096;
const MAX_LEGACY_COUNT = 1_000_000;

/**
 * Reminder state of `id` in `dir`. `has(suffix)` reports whether
 * `<id>.<suffix>` exists (a directory listing or existsSync). At most
 * INBOX_MAX_REMINDERS existence checks plus two small reads.
 */
export function readReminderState(dir: string, id: string, has: (suffix: string) => boolean): ReminderState {
  const legacy = has('reminded') ? readLegacy(join(dir, `${id}.reminded`)) : { count: 0 };
  for (let n = INBOX_MAX_REMINDERS; n > legacy.count; n--) {
    if (has(`reminded.${n}`)) return { count: n, ...readAt(join(dir, `${id}.reminded.${n}`)) };
  }
  return legacy;
}

/**
 * Claim the next reminder of `id`: when the count is below
 * INBOX_MAX_REMINDERS and `isDue(state)` holds, create
 * `<id>.reminded.<count + 1>` with O_EXCL and return the new count; null when
 * capped, not due, or another consumer created that reminder first.
 */
export function claimNextReminder(
  dir: string, id: string, now: number, isDue: (state: ReminderState) => boolean,
): number | null {
  const state = readReminderState(dir, id, (s) => existsSync(join(dir, `${id}.${s}`)));
  const next = state.count + 1;
  if (next > INBOX_MAX_REMINDERS || !isDue(state)) return null;
  try {
    writeFileSync(join(dir, `${id}.reminded.${next}`), JSON.stringify({ at: new Date(now).toISOString() }), {
      encoding: 'utf-8', mode: 0o600, flag: 'wx',
    });
    return next;
  } catch {
    return null;
  }
}

/** Legacy `{at, count}` marker: a marker without a valid count counts as 1. */
function readLegacy(path: string): ReminderState {
  const r = readJsonBounded(path, SMALL_FILE_BYTES);
  if (r === null) return existsSync(path) ? { count: 1 } : { count: 0 };
  if (r === 'oversized') return { count: 1 };
  const v = r.value as { at?: unknown; count?: unknown } | null;
  const c = v?.count;
  const count = typeof c === 'number' && Number.isSafeInteger(c) && c >= 1 ? Math.min(c, MAX_LEGACY_COUNT) : 1;
  return v && isCanonicalIso(v.at) ? { at: v.at, count } : { count };
}

/**
 * `{at}` of a per-count marker; falls back to the file's mtime when the body
 * is missing or invalid (e.g. a crash between the O_EXCL create and the write).
 */
function readAt(path: string): { at?: string } {
  const r = readJsonBounded(path, SMALL_FILE_BYTES);
  if (r && r !== 'oversized') {
    const v = r.value as { at?: unknown } | null;
    if (v && isCanonicalIso(v.at)) return { at: v.at };
  }
  try {
    return { at: new Date(statSync(path).mtimeMs).toISOString() };
  } catch {
    return {};
  }
}

/** The timestamps that count as activity on a message. */
export interface MailActivity {
  received_at: string;
  delivered_at?: string;
  reminded_at?: string;
}

/** Latest of received / delivered / last-reminded, in ms. */
export function lastActivityMs(a: MailActivity): number {
  return Math.max(...[a.received_at, a.delivered_at, a.reminded_at].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite));
}

/**
 * True when unanswered mail may be closed as expired: it is agent mail
 * (isExpirableMail — human mail never expires) and its last activity is older
 * than AGENT_MAIL_TTL_MS.
 */
export function isIdlePastTtl(rec: { from: string; to: string } & MailActivity, now: number): boolean {
  return isExpirableMail(rec) && now - lastActivityMs(rec) > AGENT_MAIL_TTL_MS;
}

/** Store access expireIdleAgentMail needs (ClaudeInbox private helpers). */
export interface ExpiryDeps {
  readRecord: (id: string) => ({ from: string; to: string; received_at: string }) | null;
  deliveredAt: (id: string) => string | undefined;
  /** Create the answered(via 'expired') marker; true when this call made the transition. */
  close: (id: string) => boolean;
}

/**
 * Close each candidate (unanswered, id older than the TTL — `names` is the
 * directory listing) whose last activity is past AGENT_MAIL_TTL_MS, and tag it
 * `<id>.expired` so stats() can count expiries from names alone. Returns the
 * ids this call closed.
 */
export function expireIdleAgentMail(
  dir: string, names: readonly string[], candidates: readonly string[], now: number, deps: ExpiryDeps,
): string[] {
  const present = new Set(names);
  const out: string[] = [];
  for (const id of candidates) {
    const rec = deps.readRecord(id);
    if (!rec) continue;
    const activity = {
      from: rec.from, to: rec.to, received_at: rec.received_at,
      delivered_at: present.has(`${id}.delivered`) ? deps.deliveredAt(id) : undefined,
      reminded_at: readReminderState(dir, id, (s) => present.has(`${id}.${s}`)).at,
    };
    if (!isIdlePastTtl(activity, now) || !deps.close(id)) continue;
    try {
      writeFileSync(join(dir, `${id}.expired`), JSON.stringify({ at: new Date(now).toISOString() }), {
        encoding: 'utf-8', mode: 0o600, flag: 'wx',
      });
    } catch { /* stats-only tag */ }
    out.push(id);
  }
  return out;
}
