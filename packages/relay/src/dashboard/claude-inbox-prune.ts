/**
 * claude-inbox-prune.ts — pure prune planning + persisted prune telemetry for
 * the durable Claude inbox (claude-inbox.ts).
 *
 * Policy: only ANSWERED records are ever removed (past retention, or beyond
 * the answered-count cap, oldest first). Queued and delivered-unanswered
 * records are never pruned — the store refuses new appends instead.
 */

import { join } from 'path';
import { atomicWrite0600, isCanonicalIso, readJsonBounded } from './claude-inbox-io';

export interface PrunePlan {
  /** Record ids to remove together with all their aux files. */
  drop: Set<string>;
  /** Other directory entries to unlink (orphans, stale tmp, old quarantine). */
  unlink: string[];
}

/**
 * Decide what to prune from a directory listing. `idRe` validates record ids,
 * `aux` lists per-record suffixes (markers) that die with their record.
 */
export function planPrune(
  names: readonly string[], now: number,
  opts: { idRe: RegExp; aux: readonly string[]; retentionMs: number; maxAnswered: number },
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
  for (const n of names) {
    const base = n.split('.')[0];
    if (drop.has(base)) continue; // removed with its record
    const isAux = opts.aux.some((m) => n === `${base}.${m}`);
    if (isAux && !idSet.has(base)) unlink.push(n);
    else if (n.endsWith('.tmp') && age(base) > 60_000) unlink.push(n);
    else if (n === `${base}.quarantine` && age(base) > opts.retentionMs) unlink.push(n);
  }
  return { drop, unlink };
}

export interface PruneLog {
  total: number;
  at?: string;
}

/** `.gossip/bridge/inbox-prune.json` next to the inbox dir. */
export function pruneLogPath(inboxDir: string): string {
  return join(inboxDir, '..', 'inbox-prune.json');
}

export function readPruneLog(inboxDir: string): PruneLog {
  const r = readJsonBounded(pruneLogPath(inboxDir), 4096);
  if (!r || r === 'oversized') return { total: 0 };
  const v = r.value as { total?: unknown; at?: unknown } | null;
  const total = v && typeof v.total === 'number' && Number.isSafeInteger(v.total) && v.total >= 0 ? v.total : 0;
  return v && isCanonicalIso(v.at) ? { total, at: v.at } : { total };
}

/** Add `count` removals to the persisted log; returns the new log. Best effort. */
export function recordPrune(inboxDir: string, count: number, now: number): PruneLog {
  const log: PruneLog = { total: readPruneLog(inboxDir).total + count, at: new Date(now).toISOString() };
  try {
    atomicWrite0600(pruneLogPath(inboxDir), JSON.stringify({ ...log, last_count: count }));
  } catch { /* telemetry only */ }
  return log;
}
