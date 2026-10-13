/**
 * Per-consumer watcher heartbeats (.gossip/bridge/watchers/<pid>.json) —
 * agent-inbox spec step 5.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  clearWatcherHeartbeat, computeClaudeLink, countLiveWatchers, isWatcherListening, readWatcherHeartbeats,
  watcherConsumerPathFor, watcherHeartbeatPathFor, watchersDirFor, writeWatcherHeartbeat, WATCHER_PRUNE_MS, WATCHER_SCAN_MAX,
} from '@gossip/relay/dashboard/claude-inbox-watcher';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'inbox-watchers-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Two live pids: this process and its parent.
const A = process.pid;
const B = process.ppid;

describe('per-consumer watcher heartbeats', () => {
  it('two watchers keep separate heartbeats; listeners = 2; one clearing leaves the other', () => {
    const now = Date.now();
    writeWatcherHeartbeat(root, now, A);
    writeWatcherHeartbeat(root, now + 1, B);
    expect(statSync(watchersDirFor(root)).mode & 0o777).toBe(0o700);
    expect(statSync(watcherConsumerPathFor(root, B)).mode & 0o777).toBe(0o600);
    expect(countLiveWatchers(root, now + 2)).toBe(2);
    expect(computeClaudeLink({ hasSink: false, channelConfirmed: false, projectRoot: root, now: now + 2 }))
      .toMatchObject({ state: 'listening', listeners: 2, last_seen: new Date(now + 1).toISOString() });

    clearWatcherHeartbeat(root, 0, now + 3, A);
    expect(existsSync(watcherConsumerPathFor(root, A))).toBe(false);
    expect(existsSync(watcherConsumerPathFor(root, B))).toBe(true);
    expect(isWatcherListening(root, now + 4)).toBe(true);
    expect(computeClaudeLink({ hasSink: true, channelConfirmed: false, projectRoot: root, now: now + 4 }))
      .toMatchObject({ state: 'listening', listeners: 1 });
    expect(computeClaudeLink({ hasSink: true, channelConfirmed: true, projectRoot: root, now: now + 4 }))
      .toEqual({ state: 'channel', listeners: 1 });
  });

  it('prunes per-consumer files older than WATCHER_PRUNE_MS and ignores pid/name mismatches', () => {
    const now = Date.now();
    mkdirSync(watchersDirFor(root), { recursive: true });
    writeFileSync(watcherConsumerPathFor(root, 4242), JSON.stringify({ pid: 4242, at: new Date(now - WATCHER_PRUNE_MS - 1000).toISOString() }));
    writeFileSync(watcherConsumerPathFor(root, 4343), JSON.stringify({ pid: A, at: new Date(now).toISOString() })); // forged pid
    const tmp = join(watchersDirFor(root), `${A}.json.${A}.abc.tmp`);
    writeFileSync(tmp, '{}');
    utimesSync(tmp, new Date(now - 120_000), new Date(now - 120_000));
    expect(readWatcherHeartbeats(root, now)).toEqual([]);
    expect(existsSync(watcherConsumerPathFor(root, 4242))).toBe(false);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(watcherConsumerPathFor(root, 4343))).toBe(true); // fresh mismatch: ignored, not yet pruned
  });

  it('a dead pid is not a listener', () => {
    const now = Date.now();
    writeWatcherHeartbeat(root, now, 2 ** 22 + 12345);
    expect(countLiveWatchers(root, now)).toBe(0);
  });

  it('still reads the legacy single inbox-watcher.json', () => {
    const now = Date.now();
    mkdirSync(join(root, '.gossip', 'bridge'), { recursive: true });
    writeFileSync(watcherHeartbeatPathFor(root), JSON.stringify({ pid: A, at: new Date(now).toISOString() }));
    expect(isWatcherListening(root, now)).toBe(true);
    writeWatcherHeartbeat(root, now, A); // same pid in both → one listener
    expect(countLiveWatchers(root, now)).toBe(1);
    clearWatcherHeartbeat(root, 0, now, A); // removes ours, including the legacy file
    expect(existsSync(watcherHeartbeatPathFor(root))).toBe(false);
    expect(countLiveWatchers(root, now)).toBe(0);
  });

  it('a live watcher is found behind more than WATCHER_SCAN_MAX stale entries', () => {
    const now = Date.now();
    const dir = watchersDirFor(root);
    mkdirSync(dir, { recursive: true });
    const staleAt = new Date(now - 10 * 60_000);
    for (let i = 0; i < WATCHER_SCAN_MAX + 6; i++) {
      const pid = 3_000_000 + i;
      const p = watcherConsumerPathFor(root, pid);
      writeFileSync(p, JSON.stringify({ pid, at: staleAt.toISOString() }));
      utimesSync(p, staleAt, staleAt);
    }
    writeWatcherHeartbeat(root, now, A);
    expect(readWatcherHeartbeats(root, now).map((h) => h.pid)).toContain(A);
    expect(countLiveWatchers(root, now)).toBe(1);
  });

  it('never touches non-heartbeat names in the watchers dir', () => {
    const now = Date.now();
    const dir = watchersDirFor(root);
    mkdirSync(dir, { recursive: true });
    const old = new Date(now - WATCHER_PRUNE_MS - 60_000);
    for (const n of ['notes.tmp', 'x.json', 'abc.json.1.ff.tmp']) {
      writeFileSync(join(dir, n), '{}');
      utimesSync(join(dir, n), old, old);
    }
    readWatcherHeartbeats(root, now);
    expect(readdirSync(dir).sort()).toEqual(['abc.json.1.ff.tmp', 'notes.tmp', 'x.json']);
  });

  it('a symlinked watchers dir is never written, read or pruned through', () => {
    const now = Date.now();
    const target = mkdtempSync(join(tmpdir(), 'inbox-watchers-target-'));
    try {
      const stale = join(target, '4242.json');
      writeFileSync(stale, JSON.stringify({ pid: 4242, at: new Date(now - WATCHER_PRUNE_MS - 1000).toISOString() }));
      writeFileSync(join(target, `${A}.json`), JSON.stringify({ pid: A, at: new Date(now).toISOString() }));
      mkdirSync(join(root, '.gossip', 'bridge'), { recursive: true });
      symlinkSync(target, watchersDirFor(root));
      writeWatcherHeartbeat(root, now, B);
      expect(existsSync(join(target, `${B}.json`))).toBe(false);
      expect(readWatcherHeartbeats(root, now)).toEqual([]);
      expect(existsSync(stale)).toBe(true);
      clearWatcherHeartbeat(root, 0, now, A);
      expect(existsSync(join(target, `${A}.json`))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
