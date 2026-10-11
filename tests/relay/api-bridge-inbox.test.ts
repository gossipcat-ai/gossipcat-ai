/**
 * BridgeHub ⇄ durable Claude inbox: persist-first, queue-without-sink (202, not
 * 503), channel-confirmed delivery (no double delivery), reply → answered,
 * restart-safe reply binding, and the dashboard status snapshot.
 */
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { BridgeHub, validateAskQuestions } from '@gossip/relay/dashboard/api-bridge';
import { ClaudeInbox, inboxDirFor, INBOX_MAX_UNANSWERED } from '@gossip/relay/dashboard/claude-inbox';

function mockReq(url: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & { method: string; url: string; headers: object };
  req.method = 'GET';
  req.url = url;
  req.headers = {};
  return req;
}
function mockRes(): ServerResponse {
  const res = new EventEmitter() as unknown as Record<string, unknown>;
  res.writeHead = () => res;
  res.write = () => true;
  res.end = () => {};
  res.destroy = () => {};
  return res as unknown as ServerResponse;
}

let root: string;
let inbox: ClaudeInbox;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bridge-inbox-'));
  inbox = new ClaudeInbox(inboxDirFor(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('BridgeHub with durable inbox', () => {
  it('no sink → 202 queued + persisted (instead of 503)', () => {
    const hub = new BridgeHub({ projectRoot: root });
    const r = hub.handlePost({ chat_id: 'chat-a', message: 'hello claude' });
    expect(r.status).toBe(202);
    expect(r.payload).toMatchObject({ ok: true, chat_id: 'chat-a', delivery: 'queued', live: false });
    const entries = inbox.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: r.payload.inbox_id, chat_id: 'chat-a', content: 'hello claude', status: 'queued' });
  });

  it('legacy hub without projectRoot keeps the 503 contract', () => {
    const hub = new BridgeHub();
    expect(hub.handlePost({ chat_id: 'chat-a', message: 'x' }).status).toBe(503);
  });

  it('sink accepted but channel NOT confirmed → stays queued (CC may have dropped it)', () => {
    const hub = new BridgeHub({ projectRoot: root });
    const sink = jest.fn(() => true);
    hub.registerSink(sink);
    const r = hub.handlePost({ chat_id: 'chat-a', message: 'm' });
    expect(sink).toHaveBeenCalledWith('chat-a', 'm');
    expect(r.payload).toMatchObject({ delivery: 'queued' });
    expect(inbox.queued()).toHaveLength(1);
  });

  it('channel confirmed + sink accept → still QUEUED until a consumer claims it or reply answers (I3)', () => {
    const hub = new BridgeHub({ projectRoot: root });
    hub.registerSink(() => true);
    hub.setChannelConfirmed(true);
    const r = hub.handlePost({ chat_id: 'chat-a', message: 'm' });
    // An optimistic sink accept is not proof CC saw it — never marked delivered.
    expect(r.payload).toMatchObject({ delivery: 'queued', live: true });
    expect(inbox.queued()).toHaveLength(1);
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chat-a'), mockRes());
    expect(hub.emitReply('chat-a', 'done')).toBe(true);
    expect(inbox.list()[0].status).toBe('answered');
  });

  it('a full inbox (unanswered) answers 507 and never evicts an older message (I5)', () => {
    const hub = new BridgeHub({ projectRoot: root });
    for (let i = 0; i < INBOX_MAX_UNANSWERED; i++) inbox.append('chat-a', `m${i}`, Date.now() - 10_000 + i);
    const r = hub.handlePost({ chat_id: 'chat-a', message: 'overflow' });
    expect(r.status).toBe(507);
    expect(r.payload).toMatchObject({ inbox_full: true, chat_id: 'chat-a' });
    expect(String(r.payload.error)).toContain('inbox is full');
    expect(inbox.list().some((e) => e.content === 'overflow')).toBe(false);
    expect(inbox.list()).toHaveLength(INBOX_MAX_UNANSWERED);
    const snap = hub.inboxSnapshot('chat-a');
    expect(snap.payload.stats).toMatchObject({ unanswered: INBOX_MAX_UNANSWERED, max_unanswered: INBOX_MAX_UNANSWERED });
  });

  it('reply with NO open stream is queued, marked answered, and flushed exactly once on stream open (I2)', () => {
    const hub = new BridgeHub({ projectRoot: root });
    hub.handlePost({ chat_id: 'chat-a', message: 'question' });
    expect(hub.emitReplyStatus('chat-a', 'the answer')).toBe('queued');
    expect(inbox.list()[0].status).toBe('answered');
    expect(hub.inboxSnapshot('chat-a').payload.pending_replies).toBe(1);

    // Survives a relay restart (file-backed) and is delivered on the next stream.
    const hub2 = new BridgeHub({ projectRoot: root });
    const writes: string[] = [];
    const res = mockRes();
    (res as unknown as { write: (s: string) => boolean }).write = (s: string) => { writes.push(s); return true; };
    hub2.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chat-a'), res);
    const frames = writes.filter((w) => w.startsWith('data: ')).map((w) => JSON.parse(w.slice(6)));
    expect(frames).toEqual([expect.objectContaining({ type: 'reply', chat_id: 'chat-a', text: 'the answer' })]);

    // A second stream for the same chat gets nothing (delivered once).
    const again: string[] = [];
    const res2 = mockRes();
    (res2 as unknown as { write: (s: string) => boolean }).write = (s: string) => { again.push(s); return true; };
    hub2.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chat-a'), res2);
    expect(again.filter((w) => w.includes('the answer'))).toHaveLength(0);
    // With a stream open, a reply is delivered live.
    expect(hub2.emitReplyStatus('chat-a', 'live one')).toBe('delivered');
  });

  it('a stream for ANOTHER chat does not swallow the reply — it is queued for its own chat', () => {
    const hub = new BridgeHub({ projectRoot: root });
    hub.handlePost({ chat_id: 'chat-a', message: 'q' });
    hub.handlePost({ chat_id: 'chat-b', message: 'q' });
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chat-b'), mockRes());
    expect(hub.emitReplyStatus('chat-a', 'for a')).toBe('queued');
    expect(hub.emitReplyStatus('forged', 'x')).toBe('rejected');
  });

  it('a throwing / rejecting sink still queues (202) because the message is persisted', () => {
    const hub = new BridgeHub({ projectRoot: root });
    hub.registerSink(() => { throw new Error('boom'); });
    hub.setChannelConfirmed(true);
    const r = hub.handlePost({ chat_id: 'chat-a', message: 'm' });
    expect(r.status).toBe(202);
    expect(r.payload).toMatchObject({ delivery: 'queued' });
  });

  it('reply marks the chat answered; a NEW hub (restart) can still reply to a persisted chat_id', () => {
    const hub1 = new BridgeHub({ projectRoot: root });
    hub1.handlePost({ chat_id: 'chat-a', message: 'm1' });

    // Simulated MCP/relay restart: fresh hub, empty in-memory knownChatIds.
    const hub2 = new BridgeHub({ projectRoot: root });
    hub2.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chat-a'), mockRes());
    expect(hub2.emitReply('chat-a', 'done')).toBe(true);
    expect(inbox.list()[0].status).toBe('answered');
    // A never-persisted id is still rejected.
    expect(hub2.emitReply('forged-id', 'x')).toBe(false);
  });

  it('inboxSnapshot reports per-message status + link state, filtered by chat', () => {
    const hub = new BridgeHub({ projectRoot: root });
    hub.handlePost({ chat_id: 'chat-a', message: 'a' });
    hub.handlePost({ chat_id: 'chat-b', message: 'b' });
    const snap = hub.inboxSnapshot('chat-a');
    expect(snap.status).toBe(200);
    expect(snap.payload.link).toEqual({ state: 'offline' });
    expect(snap.payload.messages).toEqual([expect.objectContaining({ status: 'queued' })]);
    // content is NOT echoed by the status endpoint
    expect(JSON.stringify(snap.payload)).not.toContain('"a"');
    expect(hub.inboxSnapshot('bad id!').status).toBe(400);
    hub.registerSink(() => true);
    expect(hub.inboxSnapshot(null).payload.link).toEqual({ state: 'session' });
  });

  it('gossip_ask answers are persisted and queue without a sink', () => {
    const hub = new BridgeHub({ projectRoot: root });
    hub.handlePost({ chat_id: 'chat-a', message: 'open' });
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chat-a'), mockRes());
    const v = validateAskQuestions([{ header: 'Pick', question: 'which?', options: [{ label: 'A' }, { label: 'B' }] }]);
    if (!('questions' in v)) throw new Error('invalid fixture');
    expect(hub.emitQuestion('chat-a', 'qid-1', v.questions)).toBe(true);
    const r = hub.handleAnswer({ chat_id: 'chat-a', answer: { qid: 'qid-1', responses: [{ questionId: 'q0', selected: ['A'] }] } });
    expect(r.status).toBe(202);
    expect(r.payload).toMatchObject({ delivery: 'queued' });
    expect(inbox.list().map((e) => e.content)).toContain('[answer qid=qid-1] Pick: A');
  });
});
