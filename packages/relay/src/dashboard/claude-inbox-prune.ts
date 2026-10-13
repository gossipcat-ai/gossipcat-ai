/**
 * claude-inbox-prune.ts — pure prune planning + persisted prune telemetry for
 * the durable Claude inbox (claude-inbox.ts).
 *
 * Policy: only ANSWERED records are ever removed (past retention, or beyond
 * the answered-count cap, oldest first). Queued and delivered-unanswered
 * records are never pruned — the store refuses new appends instead.
 *
 * Agent mail TTL: agent → orchestrator and orchestrator → agent mail whose
 * last activity (received, delivered or reminded) is older than
 * AGENT_MAIL_TTL_MS while still unanswered is closed as answered(via
 * 'expired') by the store's prune pass, so it stops counting toward the caps.
 * Human mail never expires.
 */

import { join } from 'path';
import { atomicWrite0600, isCanonicalIso, readJsonBounded } from './claude-inbox-io';

export interface PrunePlan {
  /** Record ids to remove together with all their aux files. */
  drop: Set<string>;
  /** Other directory entries to unlink (orphans, stale tmp, old quarantine). */
  unlink: string[];
}

/** A `.tmp` file (atomic write in progress) whose own mtime is older than this is stale. */
export const TMP_STALE_MS = 60_000;

/**
 * Decide what to prune from a directory listing. `idRe` validates record ids,
 * `aux` lists per-record suffixes (markers) that die with their record.
 * `.tmp` files are aged by their OWN mtime (`mtimeOf`, null = gone), never by
 * the message id — a fresh temp file of an old message is still being written.
 * At most `maxStats` tmp files are stat'ed per pass.
 */
export function planPrune(
  names: readonly string[], now: number,
  opts: {
    idRe: RegExp; aux: readonly string[]; retentionMs: number; maxAnswered: number;
    mtimeOf: (name: string) => number | null; maxStats: number;
  },
): PrunePlan {
  const present = new Set(names);
  const ids = names
    .filter((n) => n.endsWith('.json') && opts.idRe.test(n.slice(0, -5)))
    .map((n) => n.slice(0, -5))
    .sort();
  const age = (id: string): number => now - Number(id.slice(0, 13));
  const answered = ids.filter((id) => present.has(`${id}.answered`));
  const drop = new Set<string>(answered.filter((id) => age(id) > opts.retentionMs));
  const keptAnswered = answered.filter((id) => !drop.has(id));
  for (let i = 0; i < keptAnswered.length - opts.maxAnswered; i++) drop.add(keptAnswered[i]);
  const idSet = new Set(ids);
  const unlink: string[] = [];
  let stats = 0;
  const staleTmp = (n: string): boolean => {
    if (++stats > opts.maxStats) return false;
    const mtime = opts.mtimeOf(n);
    return mtime !== null && now - mtime > TMP_STALE_MS;
  };
  for (const n of names) {
    const base = n.split('.')[0];
    if (drop.has(base)) continue; // removed with its record
    const isAux = opts.aux.some((m) => n === `${base}.${m}`);
    if (isAux && !idSet.has(base)) unlink.push(n);
    else if (n.endsWith('.tmp')) { if (staleTmp(n)) unlink.push(n); }
    else if (n === `${base}.quarantine` && age(base) > opts.retentionMs) unlink.push(n);
  }
  return { drop, unlink };
}

/** Unanswered agent mail older than this is closed as answered(via 'expired'). */
export const AGENT_MAIL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * True for mail that may expire: agent-authored mail to the orchestrator, or
 * orchestrator mail to an agent. Mail from the human (or to the human) never expires.
 */
export function isExpirableMail(env: { from: string; to: string }): boolean {
  if (env.from === 'human' || env.to === 'human') return false;
  if (env.from === 'orchestrator') return env.to !== 'orchestrator';
  return env.to === 'orchestrator';
}

/**
 * Unanswered record ids older than `ttlMs` (by their ms id prefix), oldest
 * first and at most `max` — names only, no reads. The id is the EARLIEST
 * activity, so this is only a pre-filter: the store then checks the last
 * activity (claude-inbox-reminder.ts isIdlePastTtl).
 */
export function planExpiryCandidates(
  names: readonly string[], now: number, opts: { idRe: RegExp; ttlMs: number; max: number },
): string[] {
  const present = new Set(names);
  const out: string[] = [];
  for (const n of [...names].sort()) {
    if (out.length >= opts.max) break;
    const id = n.slice(0, -5);
    if (!n.endsWith('.json') || !opts.idRe.test(id) || present.has(`${id}.answered`)) continue;
    if (now - Number(id.slice(0, 13)) > opts.ttlMs) out.push(id);
  }
  return out;
}

export interface PruneLog {
  total: number;
  at?: string;
  /** Agent mail closed by the TTL, cumulative. */
  expired_agent_mail: number;
}

/** `.gossip/bridge/inbox-prune.json` next to the inbox dir. */
export function pruneLogPath(inboxDir: string): string {
  return join(inboxDir, '..', 'inbox-prune.json');
}

export function readPruneLog(inboxDir: string): PruneLog {
  const r = readJsonBounded(pruneLogPath(inboxDir), 4096);
  if (!r || r === 'oversized') return { total: 0, expired_agent_mail: 0 };
  const v = r.value as { total?: unknown; at?: unknown; expired_agent_mail?: unknown } | null;
  const total = counter(v?.total);
  const expired = counter(v?.expired_agent_mail);
  return v && isCanonicalIso(v.at) ? { total, at: v.at, expired_agent_mail: expired } : { total, expired_agent_mail: expired };
}

function counter(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/**
 * Add `removed` records and `expired` agent-mail expiries to the persisted log;
 * returns the new log. Best effort.
 */
export function recordPrune(inboxDir: string, counts: { removed: number; expired: number }, now: number): PruneLog {
  const prev = readPruneLog(inboxDir);
  const log: PruneLog = {
    total: prev.total + counts.removed,
    at: new Date(now).toISOString(),
    expired_agent_mail: prev.expired_agent_mail + counts.expired,
  };
  try {
    atomicWrite0600(pruneLogPath(inboxDir), JSON.stringify({
      ...log, last_count: counts.removed, last_expired: counts.expired,
    }));
  } catch { /* telemetry only */ }
  return log;
}
