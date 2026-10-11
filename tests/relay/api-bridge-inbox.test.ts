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
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';

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

  it('channel confirmed + sink accept → delivered via channel (no double delivery)', () => {
    const hub = new BridgeHub({ projectRoot: root });
    hub.registerSink(() => true);
    hub.setChannelConfirmed(true);
    const r = hub.handlePost({ chat_id: 'chat-a', message: 'm' });
    expect(r.payload).toMatchObject({ delivery: 'delivered', live: true });
    expect(inbox.queued()).toHaveLength(0);
    expect(inbox.list()[0]).toMatchObject({ status: 'delivered', delivered_via: 'channel' });
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
