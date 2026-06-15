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
  res._destroyed = false;
  res.writeHead = (code: number) => { res._status = code; return res; };
  res.write = (chunk: string) => { res._writes.push(chunk); return true; };
  res.end = () => {};
  res.destroy = () => { res._destroyed = true; };
  return res;
}

/** A mockRes whose res.write() returns false after `okWrites` successful calls,
 *  simulating a full socket buffer (backpressure). */
function backpressureRes(okWrites: number): SSERes {
  const res = mockRes();
  let n = 0;
  (res as any).write = (chunk: string) => {
    res._writes.push(chunk);
    n++;
    return n <= okWrites;
  };
  return res;
}

function dataFramesOf(res: SSERes): any[] {
  return res._writes
    .filter((w) => w.includes('data:'))
    .map((w) => JSON.parse(w.slice(w.indexOf('data: ') + 6).trim()));
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

  it('FIFO-overflow gap: emits a restart sentinel + full replay when oldest frames were evicted (f7)', () => {
    // ringMax tiny so early frames FIFO-evict. The hub's MirrorEventStore uses
    // MIRROR_RING_MAX, so drive the eviction through many pushes instead.
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    // Push past MIRROR_RING_MAX (100) so the oldest are FIFO-evicted; lowest
    // retained id becomes 110-99=11 (ids 11..110 retained).
    const batch: InboundMirrorFrame[] = [];
    for (let i = 0; i < 110; i++) batch.push({ role: 'activity', text: `f${i}` });
    // emitMirror caps batch at 64 — split into two posts.
    hub.emitMirror('chatA', batch.slice(0, 55));
    hub.emitMirror('chatA', batch.slice(55, 110));
    const lowest = hub.mirrorReplay('chatA', 0)[0].id;
    expect(lowest).toBeGreaterThan(1); // oldest were evicted
    // A client whose last_id sits in the EVICTED gap (e.g. 5, below `lowest`)
    // must get a restart sentinel, not a silently-truncated slice.
    const res = mockRes();
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chatA&last_id=5'), res);
    const parsed = dataFramesOf(res);
    expect(parsed[0].type).toBe('restart');
    // Then the full retained ring is replayed from 0.
    expect(parsed.slice(1)[0].id).toBe(lowest);
  });

  it('contiguous replay (no gap) does NOT emit a restart sentinel', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    hub.emitMirror('chatA', frames(['user', 'a'], ['assistant', 'b'], ['activity', 'c'])); // 1,2,3
    const res = mockRes();
    // last_id=1: lowest replayable is id 2 === lastId+1 → contiguous, no restart.
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chatA&last_id=1'), res);
    const parsed = dataFramesOf(res);
    expect(parsed.some((f) => f.type === 'restart')).toBe(false);
    expect(parsed.map((f) => f.id)).toEqual([2, 3]);
  });

  it('replay stops on backpressure instead of silently dropping frames (f10)', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatA');
    hub.emitMirror('chatA', frames(['user', 'a'], ['assistant', 'b'], ['activity', 'c'], ['user', 'd']));
    // Socket accepts 2 writes; the 3rd write succeeds-but-signals-backpressure
    // (returns false). The frame that triggers false is still flushed, but
    // replay STOPS there — frame 4 is never shoved into a full buffer.
    const res = backpressureRes(2);
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chatA&last_id=0'), res);
    const parsed = dataFramesOf(res);
    // Frames 1,2,3 written then replay halted (frame 4 NOT silently dropped into
    // a full buffer). Client reconnects with its last SSE id (3) and resumes.
    expect(parsed.map((f) => f.id)).toEqual([1, 2, 3]);
  });
});

describe('BridgeHub provisional backfill on stream open (spec §2 / f1/f7)', () => {
  let hub: BridgeHub;
  afterEach(() => hub?.dispose());

  it('drains provisional frames into a chat_id ring when its stream is first opened', () => {
    hub = new BridgeHub();
    // Terminal POSTs arrive BEFORE any stream is opened → provisional buffer.
    hub.emitMirror(null, frames(['activity', 'early-1'], ['activity', 'early-2']), 'sess-x');
    expect(hub.mirrorReplay('_provisional', 0)).toHaveLength(2);
    // Now the dashboard opens the stream (handlePost → registerMirrorChatId).
    openDashboardStream(hub, 'chatLate', 'sess-x');
    // Provisional frames are merged into chatLate, re-stamped onto its counter.
    const merged = hub.mirrorReplay('chatLate', 0);
    expect(merged.map((f) => f.text)).toEqual(['early-1', 'early-2']);
    expect(merged.map((f) => f.id)).toEqual([1, 2]); // chatLate's own ids
    // Provisional ring drained empty.
    expect(hub.mirrorReplay('_provisional', 0)).toEqual([]);
  });

  it('caps backfill at MIRROR_RING_MAX (provisional overflow is FIFO-trimmed into the dest)', () => {
    hub = new BridgeHub();
    // Fill the provisional ring beyond MIRROR_RING_MAX (100). Each emitMirror is
    // capped at 64 frames, so post in chunks.
    for (let chunk = 0; chunk < 3; chunk++) {
      const fr: InboundMirrorFrame[] = [];
      for (let i = 0; i < 50; i++) fr.push({ role: 'activity', text: `p${chunk}-${i}` });
      hub.emitMirror(null, fr, 'sess-y');
    }
    // Provisional ring itself is already FIFO-bounded at MIRROR_RING_MAX.
    expect(hub.mirrorReplay('_provisional', 0).length).toBeLessThanOrEqual(100);
    openDashboardStream(hub, 'chatCap', 'sess-y');
    expect(hub.mirrorReplay('chatCap', 0).length).toBeLessThanOrEqual(100);
    expect(hub.mirrorReplay('_provisional', 0)).toEqual([]);
  });

  it('does NOT populate provisional buffer (nothing to backfill) when dropping is configured', () => {
    hub = new BridgeHub();
    hub.setDropUnresolvedMirror(true);
    hub.emitMirror(null, frames(['activity', 'x']), 'sess-z');
    expect(hub.mirrorReplay('_provisional', 0)).toEqual([]);
    openDashboardStream(hub, 'chatD', 'sess-z');
    expect(hub.mirrorReplay('chatD', 0)).toEqual([]);
  });
});

describe('BridgeHub mirror chat_id TTL kept alive by an open SSE stream (f6)', () => {
  let hub: BridgeHub;
  afterEach(() => hub?.dispose());

  it('an open SSE stream touches the mirror chat_id TTL so it is not deauthorized', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatLive');
    expect(hub.hasMirrorChatId('chatLive')).toBe(true);
    // Age the chat_id's last-touch just past the 2h TTL — the NEXT eviction
    // pass (triggered by isMirrorChatId/registerMirrorChatId) would drop it.
    const TTL = 2 * 60 * 60 * 1000;
    hub.ageMirrorChatId('chatLive', TTL + 1_000);
    // An SSE observer connects/serves this chat_id: handleStream must touch the
    // TTL BEFORE any eviction can drop it.
    const res = mockRes();
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=chatLive&last_id=0'), res);
    // Still authorized — a subsequent mirror POST is NOT 400'd.
    expect(hub.hasMirrorChatId('chatLive')).toBe(true);
    expect(hub.emitMirror('chatLive', frames(['activity', 'after-idle'])).status).toBe(202);
  });

  it('a chat_id that was NEVER an open stream is not resurrected by handleStream (fail closed)', () => {
    hub = new BridgeHub();
    const res = mockRes();
    hub.handleStream(mockReq('/dashboard/api/bridge/stream?chat_id=ghost&last_id=0'), res);
    expect(hub.hasMirrorChatId('ghost')).toBe(false);
    expect(hub.emitMirror('ghost', frames(['activity', 'x'])).status).toBe(400);
  });
});

describe('BridgeHub keepalive lifecycle (f12)', () => {
  let hub: BridgeHub;
  afterEach(() => hub?.dispose());

  it('clears the keepalive timer when a client is evicted under backpressure', () => {
    hub = new BridgeHub();
    openDashboardStream(hub, 'chatK');
    // Connect a client that always signals backpressure (write→false).
    const res = backpressureRes(0);
    hub.handleStream(mockReq('/dashboard/api/bridge/stream'), res);
    expect(hub.keepaliveCount()).toBe(1);
    // Broadcast enough mirror frames to exceed BACKPRESSURE_EVICT_THRESHOLD (2)
    // → the client is destroyed AND its keepalive cleared (not leaked).
    hub.emitMirror('chatK', frames(['activity', '1'], ['activity', '2'], ['activity', '3'], ['activity', '4']));
    expect((res as any)._destroyed).toBe(true);
    expect(hub.clientCount()).toBe(0);
    expect(hub.keepaliveCount()).toBe(0);
  });

  it('clears the keepalive timer on a normal client close', () => {
    hub = new BridgeHub();
    const req = mockReq('/dashboard/api/bridge/stream');
    const res = mockRes();
    hub.handleStream(req, res);
    expect(hub.keepaliveCount()).toBe(1);
    req.emit('close');
    expect(hub.keepaliveCount()).toBe(0);
    expect(hub.clientCount()).toBe(0);
  });
});
