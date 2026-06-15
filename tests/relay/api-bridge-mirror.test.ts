import { BridgeHub, isMirrorRole, MIRROR_MAX_TEXT, type InboundMirrorFrame } from '@gossip/relay/dashboard/api-bridge';
import { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';

function mockReq(url: string): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = 'GET';
  req.url = url;
  req.headers = {};
  return req;
}

interface SSERes extends ServerResponse {
  _writes: string[];
  _status: number;
}

function mockRes(): SSERes {
  const res = new EventEmitter() as any;
  res._writes = [];
  res._status = 200;
  res.writeHead = (code: number) => { res._status = code; return res; };
  res.write = (chunk: string) => { res._writes.push(chunk); return true; };
  res.end = () => {};
  res.destroy = () => {};
  return res;
}

/** Seed a chat_id into mirrorChatIds via the validated inbound POST path. */
function openDashboardStream(hub: BridgeHub, chatId: string, sessionId?: string): void {
  hub.registerSink(() => true);
  const body: Record<string, unknown> = { chat_id: chatId, message: 'open' };
  if (sessionId) body.session_id = sessionId;
  const r = hub.handlePost(body);
  expect(r.status).toBe(202);
}

function frames(...roleTexts: Array<[string, string]>): InboundMirrorFrame[] {
  return roleTexts.map(([role, text]) => ({ role, text }));
}

describe('isMirrorRole', () => {
  it('accepts only the strict enum', () => {
    expect(isMirrorRole('user')).toBe(true);
    expect(isMirrorRole('assistant')).toBe(true);
    expect(isMirrorRole('activity')).toBe(true);
    expect(isMirrorRole('system')).toBe(false);
    expect(isMirrorRole('reply')).toBe(false);
    expect(isMirrorRole(undefined)).toBe(false);
    expect(isMirrorRole(123)).toBe(false);
  });
});

describe('BridgeHub.emitMirror', () => {
  let hub: BridgeHub;
  afterEach(() => hub?.dispose());

  it('stamps id + ts server-side and retains frames even with NO connected client', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    // No SSE client connected — emitReply would no-op, but emitMirror must NOT
    // gate on clients.size (deepseek:f10).
    expect(hub.clientCount()).toBe(0);
    const r = hub.emitMirror('chatA', frames(['user', 'hi'], ['assistant', 'yo']));
    expect(r.status).toBe(202);
    expect(r.payload).toMatchObject({ ok: true, chat_id: 'chatA', frames: 2 });
    const retained = hub.mirrorReplay('chatA', 0);
    expect(retained.map((f) => f.id)).toEqual([1, 2]);
    expect(retained[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // server ISO ts
  });

  it('rejects an unknown chat_id (not an open dashboard stream) with 400 — P1#1', () => {
    hub = new BridgeHub();
    // Never opened via handlePost → a hook-supplied id can NOT seed mirrorChatIds.
    const r = hub.emitMirror('hacker-id', frames(['user', 'x']));
    expect(r.status).toBe(400);
    expect(hub.mirrorReplay('hacker-id', 0)).toEqual([]);
  });

  it('rejects an unknown role anywhere in the batch with 400 and pushes NOTHING', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    const r = hub.emitMirror('chatA', [
      { role: 'user', text: 'ok' },
      { role: 'system', text: 'bad role' }, // invalid
    ]);
    expect(r.status).toBe(400);
    // No half-apply: the valid first frame must NOT have been retained.
    expect(hub.mirrorReplay('chatA', 0)).toEqual([]);
  });

  it('rejects an oversize frame text with 400', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    const big = 'x'.repeat(MIRROR_MAX_TEXT + 1);
    const r = hub.emitMirror('chatA', [{ role: 'user', text: big }]);
    expect(r.status).toBe(400);
  });

  it('rejects an empty or malformed-chat_id batch with 400', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    expect(hub.emitMirror('chatA', []).status).toBe(400);
    expect(hub.emitMirror('bad id!', frames(['user', 'x'])).status).toBe(400);
  });

  it('keeps mirrorChatIds ISOLATED from knownChatIds — mirror never widens the emitReply gate', () => {
    hub = new BridgeHub();
    // A mirror-only id that was NEVER opened by a dashboard inbound POST must
    // not be addressable by emitReply, and an emitReply gate must not let an
    // arbitrary id through emitMirror. Open ONE real stream and confirm a
    // DIFFERENT id is rejected on BOTH paths.
    openDashboardStream(hub, 'real');
    expect(hub.hasMirrorChatId('real')).toBe(true);
    expect(hub.hasMirrorChatId('other')).toBe(false);
    // emitMirror on the unopened id → 400 (mirror gate closed).
    expect(hub.emitMirror('other', frames(['user', 'x'])).status).toBe(400);
    // emitReply on the unopened id → false (known gate closed). Connect a client
    // first so clients.size!==0 isn't the reason it's false.
    const res = mockRes();
    hub.handleStream(mockReq('/dashboard/api/bridge/stream'), res);
    expect(hub.emitReply('other', 'sneaky')).toBe(false);
    // The real id IS known for replies.
    expect(hub.emitReply('real', 'legit')).toBe(true);
  });
});

describe('BridgeHub session→chat_id resolution (P1#5) + provisional buffer', () => {
  let hub: BridgeHub;
  afterEach(() => hub?.dispose());

  it('resolves a no-chat_id mirror POST through the session map', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA', 'sess-1');
    const r = hub.emitMirror(null, frames(['activity', 'bash · ls']), 'sess-1');
    expect(r.status).toBe(202);
    expect(r.payload).toMatchObject({ chat_id: 'chatA' });
    expect(hub.mirrorReplay('chatA', 0)).toHaveLength(1);
  });

  it('buffers an unresolvable terminal POST under the provisional id (default)', () => {
    hub = new BridgeHub();
    // No stream opened, no session mapping → provisional buffer.
    const r = hub.emitMirror(null, frames(['activity', 'early tool']), 'unknown-sess');
    expect(r.status).toBe(202);
    expect(r.payload).toMatchObject({ chat_id: null });
    // Retained under the provisional ring (not addressable as a real chat_id).
    expect(hub.mirrorReplay('_provisional', 0)).toHaveLength(1);
    expect(hub.mirrorRingCount()).toBe(1);
  });

  it('drops an unresolvable terminal POST when dropUnresolvedMirror is set', () => {
    hub = new BridgeHub();
    hub.setDropUnresolvedMirror(true);
    const r = hub.emitMirror(null, frames(['activity', 'x']));
    expect(r.status).toBe(202);
    expect(r.payload).toMatchObject({ chat_id: null, dropped: 1 });
    expect(hub.mirrorRingCount()).toBe(0); // nothing retained
  });
});

describe('BridgeHub.handleStream mirror replay (?last_id) + restart sentinel (P1#3)', () => {
  let hub: BridgeHub;
  afterEach(() => hub?.dispose());

  it('replays only mirror frames with id > last_id on connect, then goes live', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    hub.emitMirror('chatA', frames(['user', 'a'], ['assistant', 'b'], ['activity', 'c'])); // ids 1,2,3
    const res = mockRes();
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chatA&last_id=1'), res);
    const dataFrames = res._writes
      .filter((w) => w.includes('data:'))
      .map((w) => JSON.parse(w.slice(w.indexOf('data: ') + 6).trim()));
    // Only ids 2 and 3 replayed; all are type:'mirror' (never reply/ack).
    expect(dataFrames.map((f: any) => f.id)).toEqual([2, 3]);
    expect(dataFrames.every((f: any) => f.type === 'mirror')).toBe(true);
    // SSE id: line present so the browser exposes lastEventId.
    expect(res._writes.some((w) => /^id: 2\n/.test(w))).toBe(true);
  });

  it('emits a restart sentinel then full replay when last_id exceeds our highest id', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    // Post-restart: counter reset, only 2 frames exist (ids 1,2).
    hub.emitMirror('chatA', frames(['user', 'a'], ['assistant', 'b']));
    const res = mockRes();
    // Client holds last_id=50 from before the restart.
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chatA&last_id=50'), res);
    const parsed = res._writes
      .filter((w) => w.includes('data:'))
      .map((w) => JSON.parse(w.slice(w.indexOf('data: ') + 6).trim()));
    expect(parsed[0].type).toBe('restart');
    expect(parsed[0].chat_id).toBe('chatA');
    // Then the FULL ring (ids 1,2) is replayed so the client refetches.
    expect(parsed.slice(1).map((f: any) => f.id)).toEqual([1, 2]);
  });

  it('no chat_id query → live-only, no replay (legacy reply/ack consumer)', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    hub.emitMirror('chatA', frames(['user', 'a']));
    const res = mockRes();
    hub.handleStream(mockReq('/dashboard/api/bridge/stream'), res);
    expect(res._writes.filter((w) => w.includes('"type":"mirror"'))).toHaveLength(0);
  });
});
