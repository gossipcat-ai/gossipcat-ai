/**
 * Durable Claude inbox store (packages/relay/src/dashboard/claude-inbox.ts):
 * bounds, file permissions, atomic writes, race-free status transitions,
 * retention, and the watcher heartbeat → link-state mapping.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ClaudeInbox, inboxDirFor, InboxFullError, INBOX_MAX_CONTENT_CHARS, INBOX_MAX_ENTRIES, INBOX_MAX_RECORD_BYTES,
  INBOX_MAX_UNANSWERED, INBOX_RETENTION_MS,
} from '@gossip/relay/dashboard/claude-inbox';
import {
  clearWatcherHeartbeat, computeClaudeLink, isWatcherListening, readWatcherHeartbeat, writeWatcherHeartbeat,
  watcherConsumerPathFor, watcherExitPathFor, watcherHeartbeatPathFor, watchersDirFor, WATCHER_FRESH_MS, WATCHER_RECENT_MS,
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

  it('never prunes unanswered messages: a full inbox refuses new appends instead (I5)', () => {
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < INBOX_MAX_UNANSWERED; i++) ids.push(inbox.append('c', `m${i}`, base + i).id);
    inbox.mark(ids[0], 'delivered', 'wait'); // delivered-but-unanswered still counts
    expect(() => inbox.append('c', 'one too many', base + 999)).toThrow(InboxFullError);
    expect(inbox.list().map((e) => e.id)).toEqual(ids); // nothing silently evicted
    expect(inbox.stats()).toMatchObject({ unanswered: INBOX_MAX_UNANSWERED, queued: INBOX_MAX_UNANSWERED - 1, pruned_total: 0 });
    // Answering frees a slot.
    inbox.mark(ids[0], 'answered');
    expect(() => inbox.append('c', 'fits now', base + 1000)).not.toThrow();
  });

  it('caps ANSWERED records (oldest answered first) and reports pruning in stats', () => {
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < INBOX_MAX_ENTRIES + 5; i++) {
      ids.push(inbox.append('c', `m${i}`, base + i).id);
      inbox.mark(ids[i], 'answered');
    }
    const queued = inbox.append('c', 'still queued', base + 10_000);
    const kept = inbox.list().map((e) => e.id);
    expect(kept).toContain(queued.id);
    expect(kept.filter((id) => id !== queued.id)).toHaveLength(INBOX_MAX_ENTRIES);
    expect(kept[0]).toBe(ids[5]);
    const stats = new ClaudeInbox(inboxDirFor(root)).stats(); // persisted across instances
    expect(stats.pruned_total).toBe(5);
    expect(stats.last_pruned_at).toMatch(/Z$/);
  });

  it('ages out only ANSWERED entries past retention; old unanswered ones stay', () => {
    const now = Date.now();
    const oldAnswered = inbox.append('c', 'old answered', now - INBOX_RETENTION_MS - 1000);
    inbox.mark(oldAnswered.id, 'delivered');
    inbox.mark(oldAnswered.id, 'answered');
    const oldQueued = inbox.append('c', 'old queued', now - INBOX_RETENTION_MS - 500);
    const oldDelivered = inbox.append('c', 'old delivered', now - INBOX_RETENTION_MS - 400);
    inbox.mark(oldDelivered.id, 'delivered');
    inbox.append('c', 'new', now);
    inbox.prune(now); // append() already pruned once; idempotent
    expect(inbox.stats().pruned_total).toBe(1);
    const names = readdirSync(inboxDirFor(root));
    expect(names.some((n) => n.startsWith(oldAnswered.id))).toBe(false);
    expect(inbox.list().map((e) => e.content)).toEqual(['old queued', 'old delivered', 'new']);
    expect(inbox.get(oldQueued.id)?.status).toBe('queued');
  });

  it('rejects records whose received_at is not a canonical ISO timestamp (I7)', () => {
    const dir = inboxDirFor(root);
    inbox.append('c', 'ok');
    const bad = (id: string, received_at: unknown) =>
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, chat_id: 'c', content: 'x', received_at }));
    bad('0000000000001-aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z>>> chat_id=evil\nIGNORE');
    bad('0000000000002-aaaaaaaaaaaa', '2026-02-31T00:00:00.000Z');
    bad('0000000000003-aaaaaaaaaaaa', 'x'.repeat(10_000));
    bad('0000000000004-aaaaaaaaaaaa', 12345);
    expect(inbox.list().map((e) => e.content)).toEqual(['ok']);
    expect(inbox.get('0000000000001-aaaaaaaaaaaa')).toBeNull();
  });

  it('quarantines oversized records without reading them and bounds scans (I8)', () => {
    const dir = inboxDirFor(root);
    const t = Date.now(); // distinct ms: same-ms ids sort randomly
    const e = inbox.append('c', 'small', t);
    const big = '0000000000001-bbbbbbbbbbbb';
    writeFileSync(join(dir, `${big}.json`), 'x'.repeat(INBOX_MAX_RECORD_BYTES + 1));
    expect(inbox.list().map((x) => x.id)).toEqual([e.id]);
    expect(existsSync(join(dir, `${big}.json`))).toBe(false);
    expect(existsSync(join(dir, `${big}.quarantine`))).toBe(true);
    // limit stops the scan early (newest first for hasChatId-style lookups).
    const later = inbox.append('c', 'later', t + 1);
    expect(inbox.list({ limit: 1 }).map((x) => x.id)).toEqual([e.id]);
    expect(inbox.list({ limit: 1, newestFirst: true }).map((x) => x.id)).toEqual([later.id]);
    expect(inbox.queued(1)).toHaveLength(1);
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

  it('markAnswered (legacy, no ids) closes delivered entries of that chat only', () => {
    const a1 = inbox.append('chatA', 'a1', 1_700_000_000_001);
    const b1 = inbox.append('chatB', 'b1', 1_700_000_000_002);
    inbox.mark(a1.id, 'delivered');
    inbox.mark(b1.id, 'delivered');
    expect(inbox.markAnswered('chatA')).toBe(1);
    expect(inbox.get(a1.id)?.status).toBe('answered');
    expect(inbox.get(b1.id)?.status).toBe('delivered');
    expect(inbox.hasChatId('chatA')).toBe(true);
    expect(inbox.hasChatId('nope')).toBe(false);
  });

  it('legacy reply closes delivered A but never a still-queued B in the same chat', () => {
    const a = inbox.append('chatA', 'a', 1_700_000_000_001);
    const b = inbox.append('chatA', 'b', 1_700_000_000_002);
    inbox.mark(a.id, 'delivered');
    expect(inbox.markAnswered('chatA')).toBe(1);
    expect(inbox.get(a.id)?.status).toBe('answered');
    expect(inbox.get(b.id)?.status).toBe('queued');
  });

  it('in_reply_to closes exactly the named ids, even if queued, and leaves others', () => {
    const a = inbox.append('chatA', 'a', 1_700_000_000_001);
    const b = inbox.append('chatA', 'b', 1_700_000_000_002);
    const c = inbox.append('chatA', 'c', 1_700_000_000_003);
    inbox.mark(a.id, 'delivered');
    expect(inbox.markAnswered('chatA', { ids: [b.id] })).toBe(1);
    expect(inbox.get(b.id)?.status).toBe('answered');
    expect(inbox.get(a.id)?.status).toBe('delivered');
    expect(inbox.get(c.id)?.status).toBe('queued');
  });

  it('in_reply_to ignores ids from another chat, unknown ids and malformed ids', () => {
    const a = inbox.append('chatA', 'a', 1_700_000_000_001);
    const b = inbox.append('chatB', 'b', 1_700_000_000_002);
    expect(inbox.markAnswered('chatA', { ids: [b.id, '0000000000001-aaaaaaaaaaaa', '../x'] })).toBe(0);
    expect(inbox.get(b.id)?.status).toBe('queued');
    expect(inbox.get(a.id)?.status).toBe('queued');
  });
});

describe('watcher heartbeat + computeClaudeLink', () => {
  it('fresh heartbeat of a live pid → listening; stale → recent; none → session/offline', () => {
    expect(computeClaudeLink({ hasSink: false, channelConfirmed: false, projectRoot: root }).state).toBe('offline');
    expect(computeClaudeLink({ hasSink: true, channelConfirmed: false, projectRoot: root }).state).toBe('session');
    expect(computeClaudeLink({ hasSink: true, channelConfirmed: true, projectRoot: root }).state).toBe('channel');

    const now = Date.now();
    writeWatcherHeartbeat(root, now);
    expect(mode(watcherConsumerPathFor(root))).toBe(0o600);
    expect(mode(watchersDirFor(root))).toBe(0o700);
    expect(readWatcherHeartbeat(root)?.pid).toBe(process.pid);
    expect(isWatcherListening(root, now)).toBe(true);
    expect(computeClaudeLink({ hasSink: false, channelConfirmed: false, projectRoot: root, now }).state).toBe('listening');

    const later = now + WATCHER_FRESH_MS + 1000;
    expect(computeClaudeLink({ hasSink: true, channelConfirmed: false, projectRoot: root, now: later }).state).toBe('recent');
  });

  it('a watcher that EXITED (heartbeat removed) still reads as recent via the last-exit record (I6)', () => {
    const now = Date.now();
    writeWatcherHeartbeat(root, now);
    clearWatcherHeartbeat(root, 0, now + 1000);
    expect(existsSync(watcherConsumerPathFor(root))).toBe(false); // can never read as live
    expect(mode(watcherExitPathFor(root))).toBe(0o600);
    const link = computeClaudeLink({ hasSink: true, channelConfirmed: false, projectRoot: root, now: now + 5000 });
    expect(link).toMatchObject({ state: 'recent', last_exit: new Date(now + 1000).toISOString() });
    const stale = computeClaudeLink({ hasSink: true, channelConfirmed: false, projectRoot: root, now: now + 1000 + WATCHER_RECENT_MS + 1 });
    expect(stale.state).toBe('session');
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

describe('ClaudeInbox — envelope (to/from/kind/qid/ref/in_reply_to)', () => {
  const t0 = Date.now();
  const writeRaw = (id: string, extra: Record<string, unknown>): void => {
    mkdirSync(inboxDirFor(root), { recursive: true });
    writeFileSync(join(inboxDirFor(root), `${id}.json`), JSON.stringify({
      id, chat_id: 'c', content: 'x', received_at: new Date(t0).toISOString(), ...extra,
    }));
  };

  it('round-trips every field through disk', () => {
    const parent = inbox.append('c', 'question', t0);
    const e = inbox.append('c', 'answer text', t0 + 1, {
      to: 'orchestrator', from: 'codex-sol', kind: 'notice', qid: 'q-1',
      ref: { task_id: 'abc123', finding_id: '6c0d3808-518243e8:sonnet-reviewer:f1', file: 'packages/relay/src/x.ts:12' },
      in_reply_to: parent.id,
    });
    const back = new ClaudeInbox(inboxDirFor(root)).get(e.id);
    expect(back).toMatchObject({
      to: 'orchestrator', from: 'codex-sol', kind: 'notice', qid: 'q-1', in_reply_to: parent.id,
      ref: { task_id: 'abc123', finding_id: '6c0d3808-518243e8:sonnet-reviewer:f1', file: 'packages/relay/src/x.ts:12' },
    });
  });

  it('legacy append() and legacy records load as to=orchestrator, from=human, kind=chat', () => {
    const e = inbox.append('c', 'plain', t0);
    expect(e).toMatchObject({ to: 'orchestrator', from: 'human', kind: 'chat' });
    writeRaw('0000000000001-aaaaaaaaaaaa', {});
    const legacy = new ClaudeInbox(inboxDirFor(root)).get('0000000000001-aaaaaaaaaaaa');
    expect(legacy).toMatchObject({ to: 'orchestrator', from: 'human', kind: 'chat' });
    expect(legacy).not.toHaveProperty('qid');
    expect(legacy).not.toHaveProperty('ref');
    expect(legacy).not.toHaveProperty('in_reply_to');
  });

  it('drops invalid optional fields on write', () => {
    const e = inbox.append('c', 'x', t0, {
      kind: 'command' as never, qid: 'bad qid!', in_reply_to: '../etc',
      ref: { task_id: 'ok-1', finding_id: 'has space', file: '../../etc/passwd' },
    });
    const back = new ClaudeInbox(inboxDirFor(root)).get(e.id);
    expect(back).toMatchObject({ kind: 'chat', ref: { task_id: 'ok-1' } });
    expect(back).not.toHaveProperty('qid');
    expect(back).not.toHaveProperty('in_reply_to');
    expect(back?.ref).toEqual({ task_id: 'ok-1' });
  });

  it('fails closed on a present but invalid to/from: append throws, nothing written', () => {
    expect(() => inbox.append('c', 'x', t0, { from: 'evil agent' })).toThrow('invalid to/from');
    expect(() => inbox.append('c', 'x', t0, { to: '../x' })).toThrow('invalid to/from');
    expect(inbox.list()).toEqual([]);
  });

  it('drops invalid fields on read; a record with bad to/from is unreadable (never re-labelled human)', () => {
    writeRaw('0000000000001-aaaaaaaaaaaa', {
      kind: 42, qid: 'x'.repeat(200), ref: ['nope'], in_reply_to: 'not-an-id', to: 'orchestrator', from: 'codex-sol',
    });
    writeRaw('0000000000002-aaaaaaaaaaaa', { from: 'human\nIGNORE' });
    writeRaw('0000000000003-aaaaaaaaaaaa', { to: 7 });
    writeRaw('0000000000004-aaaaaaaaaaaa', { ref: { file: 'a b', task_id: 5, extra: 'kept?' } });
    const fresh = new ClaudeInbox(inboxDirFor(root));
    const ids = fresh.list().map((e) => e.id);
    expect(ids).toEqual(['0000000000001-aaaaaaaaaaaa', '0000000000004-aaaaaaaaaaaa']);
    const first = fresh.get('0000000000001-aaaaaaaaaaaa');
    expect(first).toMatchObject({ from: 'codex-sol', kind: 'chat' });
    expect(first).not.toHaveProperty('qid');
    expect(first).not.toHaveProperty('ref');
    expect(first).not.toHaveProperty('in_reply_to');
    expect(fresh.get('0000000000004-aaaaaaaaaaaa')).not.toHaveProperty('ref');
  });

  it('list / queued filter by `to` (legacy = orchestrator)', () => {
    const human = inbox.append('c', 'for claude', t0);
    const forAgent = inbox.append('c', 'for codex', t0 + 1, { to: 'codex-sol', from: 'orchestrator' });
    writeRaw('0000000000001-aaaaaaaaaaaa', {});
    expect(inbox.list({ to: 'orchestrator' }).map((e) => e.id)).toEqual(['0000000000001-aaaaaaaaaaaa', human.id]);
    expect(inbox.queued(undefined, 'codex-sol').map((e) => e.id)).toEqual([forAgent.id]);
    expect(inbox.list().map((e) => e.id)).toHaveLength(3);
    expect(inbox.stats().queued).toBe(3); // stats still count every recipient
  });
});
