/**
 * Durable Claude inbox store (packages/relay/src/dashboard/claude-inbox.ts):
 * bounds, file permissions, atomic writes, race-free status transitions,
 * retention, and the watcher heartbeat → link-state mapping.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ClaudeInbox, inboxDirFor, INBOX_MAX_CONTENT_CHARS, INBOX_MAX_ENTRIES, INBOX_RETENTION_MS,
} from '@gossip/relay/dashboard/claude-inbox';
import {
  computeClaudeLink, isWatcherListening, readWatcherHeartbeat, writeWatcherHeartbeat,
  watcherHeartbeatPathFor, WATCHER_FRESH_MS,
} from '@gossip/relay/dashboard/claude-inbox-watcher';

let root: string;
let inbox: ClaudeInbox;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-inbox-'));
  inbox = new ClaudeInbox(inboxDirFor(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('ClaudeInbox — append + perms', () => {
  it('persists a queued record with dir 0700 / file 0600 and no tmp leftovers', () => {
    const e = inbox.append('chat-1', 'hello');
    expect(e.status).toBe('queued');
    expect(e.id).toMatch(/^\d{13}-[0-9a-f]{12}$/);
    expect(mode(inboxDirFor(root))).toBe(0o700);
    expect(mode(join(inboxDirFor(root), `${e.id}.json`))).toBe(0o600);
    expect(readdirSync(inboxDirFor(root)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // A fresh instance (another process) reads it back from disk.
    const other = new ClaudeInbox(inboxDirFor(root));
    expect(other.list()).toEqual([expect.objectContaining({ id: e.id, chat_id: 'chat-1', content: 'hello', status: 'queued' })]);
  });

  it('rejects invalid chat_id, empty and oversize content', () => {
    expect(() => inbox.append('../x', 'hi')).toThrow('invalid chat_id');
    expect(() => inbox.append('c', '')).toThrow('empty content');
    expect(() => inbox.append('c', 'x'.repeat(INBOX_MAX_CONTENT_CHARS + 1))).toThrow('content too long');
    expect(inbox.list()).toEqual([]);
  });

  it('enforces the count cap (oldest dropped first)', () => {
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < INBOX_MAX_ENTRIES + 5; i++) ids.push(inbox.append('c', `m${i}`, base + i).id);
    const kept = inbox.list().map((e) => e.id);
    expect(kept).toHaveLength(INBOX_MAX_ENTRIES);
    expect(kept[0]).toBe(ids[5]);
    expect(kept[kept.length - 1]).toBe(ids[ids.length - 1]);
  });

  it('prunes entries past retention together with their markers', () => {
    const now = Date.now();
    const old = inbox.append('c', 'old', now - INBOX_RETENTION_MS - 1000);
    inbox.mark(old.id, 'delivered');
    inbox.append('c', 'new', now);
    inbox.prune(now);
    const names = readdirSync(inboxDirFor(root));
    expect(names.some((n) => n.startsWith(old.id))).toBe(false);
    expect(inbox.list().map((e) => e.content)).toEqual(['new']);
  });

  it('skips corrupt / foreign files instead of throwing', () => {
    const e = inbox.append('c', 'ok');
    writeFileSync(join(inboxDirFor(root), '0000000000001-aaaaaaaaaaaa.json'), '{not json');
    writeFileSync(join(inboxDirFor(root), 'evil.json'), '{}');
    expect(inbox.list().map((x) => x.id)).toEqual([e.id]);
  });
});

describe('ClaudeInbox — status transitions', () => {
  it('queued → delivered → answered, markers are idempotent and O_EXCL', () => {
    const e = inbox.append('c', 'x');
    expect(inbox.mark(e.id, 'delivered', 'wait')).toBe(true);
    expect(inbox.mark(e.id, 'delivered', 'hook')).toBe(false); // exactly one claimant wins
    expect(inbox.get(e.id)).toEqual(expect.objectContaining({ status: 'delivered', delivered_via: 'wait' }));
    expect(inbox.mark(e.id, 'answered')).toBe(true);
    expect(inbox.get(e.id)?.status).toBe('answered');
    expect(mode(join(inboxDirFor(root), `${e.id}.answered`))).toBe(0o600);
  });

  it('two store instances racing on the same marker: exactly one wins', () => {
    const e = inbox.append('c', 'x');
    const a = new ClaudeInbox(inboxDirFor(root));
    const b = new ClaudeInbox(inboxDirFor(root));
    const results = [a.mark(e.id, 'delivered', 'a'), b.mark(e.id, 'delivered', 'b')];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses unknown or path-traversal ids', () => {
    expect(inbox.mark('../../etc/passwd', 'delivered')).toBe(false);
    expect(inbox.mark('0000000000001-aaaaaaaaaaaa', 'delivered')).toBe(false);
    expect(inbox.get('../x')).toBeNull();
  });

  it('markAnsweredForChat only touches that chat', () => {
    const a1 = inbox.append('chatA', 'a1');
    const b1 = inbox.append('chatB', 'b1');
    expect(inbox.markAnsweredForChat('chatA')).toBe(1);
    expect(inbox.get(a1.id)?.status).toBe('answered');
    expect(inbox.get(b1.id)?.status).toBe('queued');
    expect(inbox.hasChatId('chatA')).toBe(true);
    expect(inbox.hasChatId('nope')).toBe(false);
  });
});

describe('watcher heartbeat + computeClaudeLink', () => {
  it('fresh heartbeat of a live pid → listening; stale → recent; none → session/offline', () => {
    expect(computeClaudeLink({ hasSink: false, channelConfirmed: false, projectRoot: root }).state).toBe('offline');
    expect(computeClaudeLink({ hasSink: true, channelConfirmed: false, projectRoot: root }).state).toBe('session');
    expect(computeClaudeLink({ hasSink: true, channelConfirmed: true, projectRoot: root }).state).toBe('channel');

    const now = Date.now();
    writeWatcherHeartbeat(root, now);
    expect(mode(watcherHeartbeatPathFor(root))).toBe(0o600);
    expect(readWatcherHeartbeat(root)?.pid).toBe(process.pid);
    expect(isWatcherListening(root, now)).toBe(true);
    expect(computeClaudeLink({ hasSink: false, channelConfirmed: false, projectRoot: root, now }).state).toBe('listening');

    const later = now + WATCHER_FRESH_MS + 1000;
    expect(computeClaudeLink({ hasSink: true, channelConfirmed: false, projectRoot: root, now: later }).state).toBe('recent');
  });

  it('a heartbeat from a dead pid is not listening', () => {
    mkdirSync(join(root, '.gossip', 'bridge'), { recursive: true });
    writeFileSync(watcherHeartbeatPathFor(root), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
    expect(isWatcherListening(root)).toBe(false);
  });

  it('malformed heartbeat is ignored', () => {
    mkdirSync(join(root, '.gossip', 'bridge'), { recursive: true });
    writeFileSync(watcherHeartbeatPathFor(root), '{"pid":"x"}');
    expect(readWatcherHeartbeat(root)).toBeNull();
  });
});
