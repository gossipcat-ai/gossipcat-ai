/**
 * claude-inbox-watcher.ts — heartbeat for `gossipcat inbox wait`.
 *
 * The blocked watcher rewrites `<root>/.gossip/bridge/inbox-watcher.json`
 * ({pid, at}, mode 0600, atomic) every few seconds. The relay reads it to tell
 * the dashboard truthfully whether a Claude session is currently listening on
 * the durable inbox (see claude-inbox.ts) — instead of inferring it from the
 * dashboard's own SSE connection.
 *
 * On exit the watcher deletes its heartbeat (so it can never read as live) and
 * writes a SEPARATE last-exit record `inbox-watcher-exit.json` ({pid, at,
 * code}). That record is what makes the `recent` link state reachable: "a
 * watcher exited a moment ago — Claude is most likely handling the batch it
 * printed and will restart the watcher".
 */

import { mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWrite0600, isCanonicalIso, readJsonBounded } from './claude-inbox-io';

/** A watcher heartbeat older than this is not "listening". */
export const WATCHER_FRESH_MS = 30_000;

/** Canonical watcher-heartbeat path for a project root. */
export function watcherHeartbeatPathFor(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'bridge', 'inbox-watcher.json');
}

/** Canonical last-exit record path for a project root. */
export function watcherExitPathFor(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'bridge', 'inbox-watcher-exit.json');
}

const SMALL_FILE_BYTES = 4096;

/** Heartbeat written by `gossipcat inbox wait` while it is blocked. */
export interface WatcherHeartbeat {
  pid: number;
  at: string;
}

export function writeWatcherHeartbeat(projectRoot: string, now: number = Date.now()): void {
  const path = watcherHeartbeatPathFor(projectRoot);
  mkdirSync(join(projectRoot, '.gossip', 'bridge'), { recursive: true, mode: 0o700 });
  atomicWrite0600(path, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
}

/**
 * Watcher exit: record the last-exit timestamp (always — the dashboard's
 * `recent` state) and remove the heartbeat when it is ours.
 */
export function clearWatcherHeartbeat(projectRoot: string, exitCode: number = 0, now: number = Date.now()): void {
  try {
    mkdirSync(join(projectRoot, '.gossip', 'bridge'), { recursive: true, mode: 0o700 });
    atomicWrite0600(watcherExitPathFor(projectRoot), JSON.stringify({
      pid: process.pid, at: new Date(now).toISOString(), code: exitCode,
    }));
  } catch { /* best effort */ }
  try {
    const hb = readWatcherHeartbeat(projectRoot);
    if (hb && hb.pid === process.pid) unlinkSync(watcherHeartbeatPathFor(projectRoot));
  } catch { /* best effort */ }
}

function readPidAt(path: string): WatcherHeartbeat | null {
  const r = readJsonBounded(path, SMALL_FILE_BYTES);
  if (!r || r === 'oversized') return null;
  const raw = r.value as Partial<WatcherHeartbeat> | null;
  if (!raw || typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  if (!isCanonicalIso(raw.at)) return null;
  return { pid: raw.pid, at: raw.at };
}

export function readWatcherHeartbeat(projectRoot: string): WatcherHeartbeat | null {
  return readPidAt(watcherHeartbeatPathFor(projectRoot));
}

/** Last `inbox wait` exit ({pid, at}), or null. */
export function readWatcherExit(projectRoot: string): WatcherHeartbeat | null {
  return readPidAt(watcherExitPathFor(projectRoot));
}

/** True when a fresh heartbeat exists and its pid is still alive. */
export function isWatcherListening(projectRoot: string, now: number = Date.now()): boolean {
  const hb = readWatcherHeartbeat(projectRoot);
  if (!hb || now - Date.parse(hb.at) > WATCHER_FRESH_MS) return false;
  try {
    process.kill(hb.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A heartbeat this recent (but no longer live) reads as "recently listening". */
export const WATCHER_RECENT_MS = 15 * 60 * 1000;

/**
 * Truthful Claude-reachability states surfaced to the dashboard:
 *   channel   — live MCP sink AND channel mode confirmed (notification reaches CC)
 *   listening — a `gossipcat inbox wait` watcher is blocked right now
 *   recent    — a watcher exited recently (Claude is likely handling a batch)
 *   session   — the MCP server is up but nothing is listening; messages queue
 *   offline   — no sink, no watcher; messages queue until a session picks them up
 */
export type ClaudeLinkState = 'channel' | 'listening' | 'recent' | 'session' | 'offline';

export interface ClaudeLink {
  state: ClaudeLinkState;
  /** ISO time of the last watcher heartbeat, when one exists. */
  last_seen?: string;
  /** ISO time the last `inbox wait` exited, when known. */
  last_exit?: string;
}

export function computeClaudeLink(opts: {
  hasSink: boolean;
  channelConfirmed: boolean;
  projectRoot: string | null;
  now?: number;
}): ClaudeLink {
  const now = opts.now ?? Date.now();
  if (opts.hasSink && opts.channelConfirmed) return { state: 'channel' };
  const hb = opts.projectRoot ? readWatcherHeartbeat(opts.projectRoot) : null;
  const exit = opts.projectRoot ? readWatcherExit(opts.projectRoot) : null;
  const extra: Omit<ClaudeLink, 'state'> = {};
  // The most recent sign of life: a heartbeat, or the exit itself.
  const seen = [hb?.at, exit?.at].filter((v): v is string => typeof v === 'string').sort().pop();
  if (seen) extra.last_seen = seen;
  if (exit) extra.last_exit = exit.at;
  if (opts.projectRoot && isWatcherListening(opts.projectRoot, now)) return { state: 'listening', ...extra };
  // `recent`: the watcher exited (or its heartbeat went stale) within the window.
  if (seen && now - Date.parse(seen) <= WATCHER_RECENT_MS) return { state: 'recent', ...extra };
  return { state: opts.hasSink ? 'session' : 'offline', ...extra };
}
