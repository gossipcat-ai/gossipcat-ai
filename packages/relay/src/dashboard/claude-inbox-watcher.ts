/**
 * claude-inbox-watcher.ts — heartbeats for `gossipcat inbox wait`.
 *
 * Each blocked watcher rewrites its OWN per-consumer file
 * `<root>/.gossip/bridge/watchers/<pid>.json` ({pid, at}, file 0600, dir 0700,
 * atomic) every few seconds, so two sessions' watchers never overwrite each
 * other. The watchers dir is used only when it is a real directory (not a
 * symlink) owned by the current user; readers touch only heartbeat-format
 * names. The relay reads the set to tell the dashboard truthfully whether a
 * Claude session is currently listening on the durable inbox (see
 * claude-inbox.ts), and how many are (`listeners`) — instead of inferring it
 * from the dashboard's own SSE connection. Readers prune per-consumer files
 * older than WATCHER_PRUNE_MS (bounded). The legacy single
 * `inbox-watcher.json` is still read as a fallback for one release.
 *
 * On exit the watcher deletes its heartbeat (so it can never read as live) and
 * writes a SEPARATE last-exit record `inbox-watcher-exit.json` ({pid, at,
 * code}). That record is what makes the `recent` link state reachable: "a
 * watcher exited a moment ago — Claude is most likely handling the batch it
 * printed and will restart the watcher".
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWrite0600, isCanonicalIso, readJsonBounded } from './claude-inbox-io';

/** A watcher heartbeat older than this is not "listening". */
export const WATCHER_FRESH_MS = 30_000;

/** Per-consumer heartbeat files older than this are deleted by readers. */
export const WATCHER_PRUNE_MS = 60 * 60 * 1000;
/** Max per-consumer heartbeat files one read parses (freshest by mtime first). */
export const WATCHER_SCAN_MAX = 64;
/** Max heartbeat-format entries one read stats (to sort by mtime and prune stale ones). */
export const WATCHER_STAT_MAX = 1024;
const WATCHER_FILE_RE = /^([1-9]\d{0,9})\.json$/;
/** atomicWrite0600's tmp of a heartbeat: `<pid>.json.<writer pid>.<hex>.tmp`. */
const WATCHER_TMP_RE = /^[1-9]\d{0,9}\.json\.\d{1,10}\.[0-9a-f]{1,32}\.tmp$/;
const TMP_STALE_MS = 60_000;

/** LEGACY single watcher-heartbeat path (read-only fallback for one release). */
export function watcherHeartbeatPathFor(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'bridge', 'inbox-watcher.json');
}

/** Directory of per-consumer watcher heartbeats. */
export function watchersDirFor(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'bridge', 'watchers');
}

/** Per-consumer heartbeat path of the watcher with `pid` (default: this process). */
export function watcherConsumerPathFor(projectRoot: string, pid: number = process.pid): string {
  return join(watchersDirFor(projectRoot), `${pid}.json`);
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

/**
 * True when `dir` is a real directory (lstat: not a symlink) owned by the
 * current uid (uid check skipped where the platform has none).
 */
function isSafeWatchersDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    return typeof process.getuid !== 'function' || st.uid === process.getuid();
  } catch {
    return false;
  }
}

/** Write this watcher's heartbeat; silently skipped when the watchers dir is unsafe (isSafeWatchersDir). */
export function writeWatcherHeartbeat(projectRoot: string, now: number = Date.now(), pid: number = process.pid): void {
  const dir = watchersDirFor(projectRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isSafeWatchersDir(dir)) return;
  // mkdirSync's mode is masked by umask and ignored for pre-existing dirs.
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  atomicWrite0600(watcherConsumerPathFor(projectRoot, pid), JSON.stringify({ pid, at: new Date(now).toISOString() }));
}

/**
 * Watcher exit: record the last-exit timestamp (always — the dashboard's
 * `recent` state) and remove the caller's own heartbeat (plus the legacy
 * single file when it is ours). Other watchers' heartbeats are untouched.
 */
export function clearWatcherHeartbeat(
  projectRoot: string, exitCode: number = 0, now: number = Date.now(), pid: number = process.pid,
): void {
  try {
    mkdirSync(join(projectRoot, '.gossip', 'bridge'), { recursive: true, mode: 0o700 });
    atomicWrite0600(watcherExitPathFor(projectRoot), JSON.stringify({
      pid, at: new Date(now).toISOString(), code: exitCode,
    }));
  } catch { /* best effort */ }
  if (isSafeWatchersDir(watchersDirFor(projectRoot))) {
    try { unlinkSync(watcherConsumerPathFor(projectRoot, pid)); } catch { /* already gone */ }
  }
  try {
    const legacy = readPidAt(watcherHeartbeatPathFor(projectRoot));
    if (legacy && legacy.pid === pid) unlinkSync(watcherHeartbeatPathFor(projectRoot));
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

/**
 * All watcher heartbeats: per-consumer files plus the legacy single file.
 * Only heartbeat-format names are considered (`<pid>.json` and its atomic-write
 * tmp); at most WATCHER_STAT_MAX are stat'ed, and the WATCHER_SCAN_MAX freshest
 * by mtime are parsed, so a live watcher is never hidden behind stale entries.
 * A file whose pid does not match its name is ignored. Heartbeats older than
 * WATCHER_PRUNE_MS and tmp files older than a minute are deleted on the way.
 * An unsafe watchers dir (symlink / not ours) is skipped entirely.
 */
export function readWatcherHeartbeats(projectRoot: string, now: number = Date.now()): WatcherHeartbeat[] {
  const out: WatcherHeartbeat[] = [];
  const dir = watchersDirFor(projectRoot);
  let names: string[] = [];
  if (isSafeWatchersDir(dir)) {
    try { names = readdirSync(dir); } catch { /* none yet */ }
  }
  const files: { name: string; path: string; mtime: number }[] = [];
  for (const name of names) {
    if (files.length >= WATCHER_STAT_MAX) break;
    const tmp = WATCHER_TMP_RE.test(name);
    if (!tmp && !WATCHER_FILE_RE.test(name)) continue;
    const path = join(dir, name);
    const mtime = fileMtime(path);
    if (mtime === null) continue;
    if (tmp) { if (now - mtime > TMP_STALE_MS) unlinkQuiet(path); continue; }
    if (now - mtime > WATCHER_PRUNE_MS) { unlinkQuiet(path); continue; }
    files.push({ name, path, mtime });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { name, path } of files.slice(0, WATCHER_SCAN_MAX)) {
    const hb = readPidAt(path);
    if (!hb || hb.pid !== Number(WATCHER_FILE_RE.exec(name)?.[1])) continue; // stale ones were pruned by mtime above
    if (now - Date.parse(hb.at) > WATCHER_PRUNE_MS) { unlinkQuiet(path); continue; }
    out.push(hb);
  }
  const legacy = readPidAt(watcherHeartbeatPathFor(projectRoot));
  if (legacy) out.push(legacy);
  return out;
}

/** mtime of a regular file (lstat: symlinks are not followed), else null. */
function fileMtime(path: string): number | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

function unlinkQuiet(path: string): void {
  try { unlinkSync(path); } catch { /* gone */ }
}

/** The freshest watcher heartbeat (any consumer, or the legacy file), or null. */
export function readWatcherHeartbeat(projectRoot: string, now: number = Date.now()): WatcherHeartbeat | null {
  return freshest(readWatcherHeartbeats(projectRoot, now));
}

function freshest(hbs: readonly WatcherHeartbeat[]): WatcherHeartbeat | null {
  let best: WatcherHeartbeat | null = null;
  for (const hb of hbs) if (!best || hb.at > best.at) best = hb;
  return best;
}

/** Last `inbox wait` exit ({pid, at}), or null. */
export function readWatcherExit(projectRoot: string): WatcherHeartbeat | null {
  return readPidAt(watcherExitPathFor(projectRoot));
}

function isLive(hb: WatcherHeartbeat, now: number): boolean {
  if (now - Date.parse(hb.at) > WATCHER_FRESH_MS) return false;
  try {
    process.kill(hb.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live listeners: distinct pids with a fresh heartbeat whose process is still alive. */
function liveListeners(hbs: readonly WatcherHeartbeat[], now: number): number {
  return new Set(hbs.filter((hb) => isLive(hb, now)).map((hb) => hb.pid)).size;
}

/** How many `inbox wait` watchers are listening right now. */
export function countLiveWatchers(projectRoot: string, now: number = Date.now()): number {
  return liveListeners(readWatcherHeartbeats(projectRoot, now), now);
}

/** True when any fresh heartbeat exists whose pid is still alive. */
export function isWatcherListening(projectRoot: string, now: number = Date.now()): boolean {
  return countLiveWatchers(projectRoot, now) > 0;
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
  /** How many `inbox wait` watchers are live right now (present when a project root is known). */
  listeners?: number;
}

export function computeClaudeLink(opts: {
  hasSink: boolean;
  channelConfirmed: boolean;
  projectRoot: string | null;
  now?: number;
}): ClaudeLink {
  const now = opts.now ?? Date.now();
  const hbs = opts.projectRoot ? readWatcherHeartbeats(opts.projectRoot, now) : [];
  const listeners = opts.projectRoot ? { listeners: liveListeners(hbs, now) } : {};
  if (opts.hasSink && opts.channelConfirmed) return { state: 'channel', ...listeners };
  const hb = freshest(hbs);
  const exit = opts.projectRoot ? readWatcherExit(opts.projectRoot) : null;
  const extra: Omit<ClaudeLink, 'state'> = { ...listeners };
  // The most recent sign of life: a heartbeat, or the exit itself.
  const seen = [hb?.at, exit?.at].filter((v): v is string => typeof v === 'string').sort().pop();
  if (seen) extra.last_seen = seen;
  if (exit) extra.last_exit = exit.at;
  if ((extra.listeners ?? 0) > 0) return { state: 'listening', ...extra };
  // `recent`: the watcher exited (or its heartbeat went stale) within the window.
  if (seen && now - Date.parse(seen) <= WATCHER_RECENT_MS) return { state: 'recent', ...extra };
  return { state: opts.hasSink ? 'session' : 'offline', ...extra };
}
