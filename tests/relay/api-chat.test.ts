import { EventEmitter } from 'events';
import { handleChat } from '../../packages/relay/src/dashboard/api-chat';
import { ChatConversationStore } from '../../packages/relay/src/dashboard/chat-session-store';
import { DashboardRouter } from '../../packages/relay/src/dashboard/routes';
import { DashboardAuth } from '../../packages/relay/src/dashboard/auth';
import { mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChatStreamEvent } from '@gossip/orchestrator';
import type { LLMMessage } from '@gossip/types';

// --- Mock req/res ------------------------------------------------------------

/** Minimal IncomingMessage stand-in — only `socket` + the 'close' event matter. */
function mockReq(): EventEmitter & { socket: { remoteAddress: string } } {
  const req = new EventEmitter() as EventEmitter & { socket: { remoteAddress: string } };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

interface MockRes {
  statusCode: number | null;
  headers: Record<string, unknown> | null;
  chunks: string[];
  ended: boolean;
  endData: string | null;
  writeHead(status: number, headers?: Record<string, unknown>): void;
  write(chunk: string): boolean;
  end(data?: string): void;
}

function mockRes(): MockRes {
  return {
    statusCode: null,
    headers: null,
    chunks: [],
    ended: false,
    endData: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? null; },
    write(chunk) { this.chunks.push(chunk); return true; },
    end(data) { this.ended = true; this.endData = data ?? null; },
  };
}

/** Parse the SSE `data: {...}` frames the handler wrote into objects. */
function parseEvents(res: MockRes): any[] {
  return res.chunks
    .map(c => c.trim())
    .filter(c => c.startsWith('data:'))
    .map(c => JSON.parse(c.slice('data:'.length).trim()));
}

/** A stub ChatbotAgent — only `turnStream` is exercised by handleChat. */
function stubAgent(events: ChatStreamEvent[]): any {
  return {
    async *turnStream(_message: string, _history: LLMMessage[]) {
      for (const ev of events) yield ev;
    },
  };
}

// --- Tests -------------------------------------------------------------------

describe('handleChat — SSE seam', () => {
  it('(1) happy path: streams conversation + token + done, ends, persists turn', async () => {
    const store = new ChatConversationStore();
    const chatbot = stubAgent([
      { type: 'token', text: 'hi' },
      { type: 'done', text: 'hi' },
    ]);
    const req = mockReq();
    const res = mockRes();

    await handleChat(req as any, res as any, { conversationId: null, message: 'hello' }, { chatbot, store });

    const events = parseEvents(res);
    const types = events.map(e => e.type);
    expect(types).toContain('conversation');
    expect(types).toContain('token');
    expect(types).toContain('done');

    const conv = events.find(e => e.type === 'conversation');
    expect(typeof conv.conversationId).toBe('string');
    expect(conv.conversationId.length).toBeGreaterThan(0);

    // (f6) SSE was opened with the event-stream content type.
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'Content-Type': 'text/event-stream' });

    expect(res.ended).toBe(true);

    // The turn (user + assistant) was appended to the minted conversation.
    const history = store.getOrCreate(conv.conversationId).messages;
    expect(history).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('(2) graceful degrade: chatbot=null emits error + done + end, no throw', async () => {
    const store = new ChatConversationStore();
    const req = mockReq();
    const res = mockRes();

    await expect(
      handleChat(req as any, res as any, { message: 'hello' }, { chatbot: null, store }),
    ).resolves.toBeUndefined();

    const events = parseEvents(res);
    const types = events.map(e => e.type);
    expect(types).toEqual(['conversation', 'error', 'done']);
    const err = events.find(e => e.type === 'error');
    expect(err.message).toMatch(/no LLM provider/i);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(200); // SSE opened, not a 4xx/5xx
  });

  it('(3) invalid message (empty) → 400 JSON, no SSE opened', async () => {
    const store = new ChatConversationStore();
    const req = mockReq();
    const res = mockRes();

    await handleChat(req as any, res as any, { message: '   ' }, { chatbot: stubAgent([]), store });

    expect(res.statusCode).toBe(400);
    expect(res.headers).toMatchObject({ 'Content-Type': 'application/json' });
    // No SSE frames were written.
    expect(parseEvents(res)).toEqual([]);
    expect(res.ended).toBe(true);
  });

  it('(3b) invalid message (non-string) → 400 JSON', async () => {
    const store = new ChatConversationStore();
    const req = mockReq();
    const res = mockRes();

    await handleChat(req as any, res as any, { message: 123 as any }, { chatbot: stubAgent([]), store });
    expect(res.statusCode).toBe(400);
    expect(parseEvents(res)).toEqual([]);
  });

  it('error during iteration becomes a terminal error event, never throws', async () => {
    const store = new ChatConversationStore();
    const boom: any = {
      async *turnStream() {
        yield { type: 'token', text: 'partial' };
        throw new Error('kaboom');
      },
    };
    const req = mockReq();
    const res = mockRes();

    await expect(
      handleChat(req as any, res as any, { message: 'hi' }, { chatbot: boom, store }),
    ).resolves.toBeUndefined();

    const events = parseEvents(res);
    const types = events.map(e => e.type);
    expect(types).toContain('error');
    // (f5) The throw path now also emits a terminal `done` so the client always
    // sees an end frame.
    expect(types).toContain('done');
    expect(res.ended).toBe(true);

    // (f5) A thrown turn must NOT be persisted — no partial/empty assistant msg
    // poisons the conversation history.
    const conv = events.find(e => e.type === 'conversation');
    expect(store.getOrCreate(conv.conversationId).messages).toEqual([]);
  });

  it('(f7) yielded error event emits error + done and does NOT persist an empty turn', async () => {
    const store = new ChatConversationStore();
    // turnStream YIELDS an error (vs throwing) then returns normally — the
    // for-await ends cleanly, so the handler must not append an empty assistant.
    const yieldsError: any = {
      async *turnStream() {
        yield { type: 'error', message: 'provider exploded' };
        // returns without a `done`
      },
    };
    const req = mockReq();
    const res = mockRes();

    await expect(
      handleChat(req as any, res as any, { message: 'hi' }, { chatbot: yieldsError, store }),
    ).resolves.toBeUndefined();

    const events = parseEvents(res);
    const types = events.map(e => e.type);
    // The yielded error is forwarded; a terminal done frame closes the stream.
    expect(types).toContain('error');
    expect(types).toContain('done');
    expect(res.ended).toBe(true);

    // Critically: nothing was persisted — no empty assistant message.
    const conv = events.find(e => e.type === 'conversation');
    expect(store.getOrCreate(conv.conversationId).messages).toEqual([]);
  });

  it('(f2) client disconnect mid-stream stops writes and does NOT persist the turn', async () => {
    const store = new ChatConversationStore();
    // A deferred promise the stub awaits forever after its first yield — the
    // generator is parked mid-turn until we resolve it (which we never do
    // before disconnect). This models a long-running tool call.
    let releaseHang!: () => void;
    const hang = new Promise<void>(resolve => { releaseHang = resolve; });

    const writesAfterClose: string[] = [];
    const req = mockReq();
    const res = mockRes();
    // Record any writes that happen after the client closes.
    const origWrite = res.write.bind(res);
    let closed = false;
    res.write = (chunk: string) => {
      if (closed) writesAfterClose.push(chunk);
      return origWrite(chunk);
    };

    const parked: any = {
      async *turnStream() {
        yield { type: 'tool_use', name: 'search', args: {} };
        // Park here; while parked, the client disconnects.
        await hang;
        // If the loop ever resumes it would try to emit more — but clientGone
        // should have been flipped, so the loop breaks before writing.
        yield { type: 'token', text: 'late' };
        yield { type: 'done', text: 'late' };
      },
    };

    const handled = handleChat(
      req as any, res as any, { message: 'hi' }, { chatbot: parked, store },
    );

    // Let the generator advance to the first yield + park on `hang`.
    await Promise.resolve();
    await Promise.resolve();

    // Client disconnects mid-stream, then the parked turn is released.
    closed = true;
    req.emit('close');
    releaseHang();

    await handled;

    // No frames were written after the disconnect (the loop broke on clientGone).
    expect(writesAfterClose).toEqual([]);
    // And the aborted turn was NOT persisted.
    const conv = parseEvents(res).find(e => e.type === 'conversation');
    expect(store.getOrCreate(conv.conversationId).messages).toEqual([]);
  });

  it('(f3) conversation continuity: turn2 receives turn1 user+assistant history', async () => {
    const store = new ChatConversationStore();

    // Turn 1: mint a new conversation, persist user+assistant.
    const agent1 = stubAgent([
      { type: 'token', text: 'first-reply' },
      { type: 'done', text: 'first-reply' },
    ]);
    const req1 = mockReq();
    const res1 = mockRes();
    await handleChat(
      req1 as any, res1 as any,
      { conversationId: null, message: 'first-msg' },
      { chatbot: agent1, store },
    );
    const conv = parseEvents(res1).find(e => e.type === 'conversation');
    const convId: string = conv.conversationId;

    // Turn 2: reuse the id; the stub records the history arg it was handed.
    let receivedHistory: LLMMessage[] | null = null;
    const recordingAgent: any = {
      async *turnStream(_message: string, history: LLMMessage[]) {
        // Snapshot the history AT CALL TIME — the store hands back the live
        // array, which the handler later mutates via append(). We assert on what
        // turn2 was actually given, not the post-append state.
        receivedHistory = history.map(m => ({ ...m }));
        yield { type: 'done', text: 'second-reply' };
      },
    };
    const req2 = mockReq();
    const res2 = mockRes();
    await handleChat(
      req2 as any, res2 as any,
      { conversationId: convId, message: 'second-msg' },
      { chatbot: recordingAgent, store },
    );

    expect(receivedHistory).toEqual([
      { role: 'user', content: 'first-msg' },
      { role: 'assistant', content: 'first-reply' },
    ]);
  });

  it('(f10) over-long conversationId → 400 JSON, no SSE opened', async () => {
    const store = new ChatConversationStore();
    const req = mockReq();
    const res = mockRes();

    await handleChat(
      req as any, res as any,
      { conversationId: 'x'.repeat(129), message: 'hi' },
      { chatbot: stubAgent([]), store },
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(parseEvents(res)).toEqual([]);
  });
});

describe('ChatConversationStore', () => {
  it('(4) getOrCreate returns [] for a new id; append accumulates', () => {
    const store = new ChatConversationStore();
    const { id, messages } = store.getOrCreate(null);
    expect(messages).toEqual([]);

    store.append(id, [{ role: 'user', content: 'a' }]);
    store.append(id, [{ role: 'assistant', content: 'b' }]);
    expect(store.getOrCreate(id).messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
  });

  it('(4b) getOrCreate is stable for an explicit id', () => {
    const store = new ChatConversationStore();
    store.getOrCreate('conv-1');
    store.append('conv-1', [{ role: 'user', content: 'x' }]);
    const second = store.getOrCreate('conv-1');
    expect(second.id).toBe('conv-1');
    expect(second.messages).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('(4c) eviction caps at MAX_CONVERSATIONS (add 21 → oldest gone, size ≤ 20)', () => {
    const store = new ChatConversationStore();
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const { id } = store.getOrCreate(`c-${i}`);
      ids.push(id);
    }
    expect(store.size()).toBeLessThanOrEqual(20);
    // The very first conversation (oldest-touched) should have been evicted:
    // re-getting it yields a fresh empty history rather than its original.
    // (We didn't append anything, so assert membership via size invariant +
    // that a re-create of c-0 doesn't push us over the cap.)
    const sizeBefore = store.size();
    store.getOrCreate('c-0');
    expect(store.size()).toBeLessThanOrEqual(20);
    expect(sizeBefore).toBeLessThanOrEqual(20);
  });

  it('(4d) eviction drops the oldest-touched entry first', () => {
    const store = new ChatConversationStore();
    // Fill to capacity, tracking that c-0 is the oldest.
    for (let i = 0; i < 20; i++) store.getOrCreate(`k-${i}`);
    store.append('k-0', [{ role: 'user', content: 'oldest' }]);
    // Touch k-0 is NOT done after; adding a 21st new conv must evict the
    // oldest-touched, which — since getOrCreate stamps lastTouched on access —
    // is whichever was touched longest ago. Force k-0 to be oldest by touching
    // every other key after it.
    for (let i = 1; i < 20; i++) store.getOrCreate(`k-${i}`);
    store.getOrCreate('k-new'); // 21st distinct → triggers evictOldest
    expect(store.size()).toBeLessThanOrEqual(20);
    // k-0 was the least-recently-touched and should be gone: re-getting it is a
    // fresh empty conversation, not the one holding 'oldest'.
    expect(store.getOrCreate('k-0').messages).toEqual([]);
  });

  it('(f8) append caps per-conversation history at 100, keeping the most recent', () => {
    const store = new ChatConversationStore();
    store.getOrCreate('cap');
    // Append 150 messages one at a time.
    for (let i = 0; i < 150; i++) {
      store.append('cap', [{ role: 'user', content: `m-${i}` }]);
    }
    const msgs = store.getOrCreate('cap').messages;
    expect(msgs.length).toBe(100);
    // The oldest 50 were trimmed from the front; the window is m-50 .. m-149.
    expect(msgs[0]).toEqual({ role: 'user', content: 'm-50' });
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'm-149' });
  });

  it('(f8b) a single over-cap append batch is trimmed to the most recent 100', () => {
    const store = new ChatConversationStore();
    // Append a 120-message batch into a fresh (recreated) entry in one call.
    const batch: LLMMessage[] = [];
    for (let i = 0; i < 120; i++) batch.push({ role: 'user', content: `b-${i}` });
    store.append('batch', batch);
    const msgs = store.getOrCreate('batch').messages;
    expect(msgs.length).toBe(100);
    expect(msgs[0]).toEqual({ role: 'user', content: 'b-20' });
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'b-119' });
  });

  it('(f4) a conversation idle past CONVERSATION_TTL_MS is evicted on next access', () => {
    jest.useFakeTimers();
    try {
      const store = new ChatConversationStore();
      store.getOrCreate('stale');
      store.append('stale', [{ role: 'user', content: 'keep-me?' }]);
      expect(store.size()).toBe(1);

      // Advance past the 2-hour idle window, then touch a DIFFERENT id —
      // getOrCreate runs eviction, so the stale entry is dropped.
      jest.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
      store.getOrCreate('fresh');

      // The stale conversation was evicted; re-getting it is a fresh empty one.
      expect(store.getOrCreate('stale').messages).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

// --- readBody backward-compat (parametrized cap) -----------------------------
//
// readBody is module-private, so it's exercised through the public router:
//   - the default-cap call sites (e.g. POST /dashboard/api/auth at the shared
//     MAX_BODY_SIZE=8KB) must reject an over-8KB body exactly as before, AND
//   - the chat route uses readBody(req, CHAT_MAX_BODY=64KB), so a body between
//     8KB and 64KB is accepted (proves the per-route cap is wired AND the
//     default is unchanged for existing sites).

function routerReq(method: string, url: string, headers: Record<string, string> = {}): any {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  req.destroy = () => { req.emit('error', new Error('destroyed')); };
  return req;
}

function routerRes(): any {
  const res = new EventEmitter() as any;
  res._status = 200;
  res._headers = {};
  res._body = '';
  res.writeHead = (code: number, headers?: Record<string, string>) => {
    res._status = code;
    if (headers) Object.assign(res._headers, headers);
    return res;
  };
  res.write = (chunk: string) => { res._body += chunk; return true; };
  res.end = (body?: string) => { if (body !== undefined) res._body += body; };
  return res;
}

function freshRouter(): { router: DashboardRouter; auth: DashboardAuth } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-chat-'));
  mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  const auth = new DashboardAuth();
  auth.init();
  const router = new DashboardRouter(auth, projectRoot, {
    agentConfigs: [], relayConnections: 0, connectedAgentIds: [],
  });
  return { router, auth };
}

describe('readBody backward-compat (per-route cap parametrization)', () => {
  it('(5) default call sites still enforce the shared 8KB cap', async () => {
    const { router } = freshRouter();
    // POST /api/auth reads with the DEFAULT cap (MAX_BODY_SIZE = 8KB) — proving
    // the parametrization left existing call sites unchanged. readBody rejects
    // an over-8KB body exactly as before this change.
    const req = routerReq('POST', '/dashboard/api/auth');
    const res = routerRes();
    const handled = router.handle(req, res);
    // 9KB body — over the 8KB default cap → readBody destroys req + rejects.
    req.emit('data', Buffer.alloc(9 * 1024, 0x61));
    req.emit('end');
    await expect(handled).rejects.toThrow(/too large/i);
  });

  it('(5a) a normal sub-8KB auth body still parses under the default cap', async () => {
    const { router, auth } = freshRouter();
    // A normal small auth body still flows (default cap unaffected at the low end).
    const req = routerReq('POST', '/dashboard/api/auth');
    const res = routerRes();
    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(JSON.stringify({ key: auth.getKey() })));
    req.emit('end');
    await handled;
    expect(res._status).toBe(200);
  });

  it('(5b) chat route accepts a body that exceeds the default 8KB cap (up to 64KB)', async () => {
    const { router, auth } = freshRouter();
    router.setChatbot(null); // graceful-degrade so the SSE path completes
    // A ~16KB message — over the 8KB default but under CHAT_MAX_BODY (64KB).
    const bigMessage = 'x'.repeat(16 * 1024);
    const body = JSON.stringify({ message: bigMessage });
    const req = routerReq('POST', '/dashboard/api/chat', {
      authorization: `Bearer ${auth.getKey()}`,
    });
    const res = routerRes();
    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(body));
    req.emit('end');
    await handled;
    // Not a 413/400 from the cap — the SSE stream opened (200) and the
    // graceful-degrade error/done frames were written.
    expect(res._status).toBe(200);
    expect(res._body).toContain('"type":"conversation"');
    expect(res._body).toContain('no LLM provider');
  });

  it('(5c) chat route rejects a body over the 64KB per-route cap', async () => {
    const { router, auth } = freshRouter();
    router.setChatbot(null);
    const req = routerReq('POST', '/dashboard/api/chat', {
      authorization: `Bearer ${auth.getKey()}`,
    });
    const res = routerRes();
    const handled = router.handle(req, res);
    // 65KB — over CHAT_MAX_BODY. readBody destroys + rejects → 400 JSON.
    req.emit('data', Buffer.alloc(65 * 1024, 0x61));
    req.emit('end');
    await handled;
    expect(res._status).toBe(400);
  });
});

describe('chat route — per-IP rate limit', () => {
  it('(f1) two rapid chat turns from one IP → second is 429', async () => {
    const { router, auth } = freshRouter();
    router.setChatbot(null); // graceful-degrade so the first turn completes fast

    const headers = { authorization: `Bearer ${auth.getKey()}` };
    const body = JSON.stringify({ message: 'hi' });

    // First turn: allowed → SSE opens (200) and graceful-degrade frames flow.
    const req1 = routerReq('POST', '/dashboard/api/chat', headers);
    const res1 = routerRes();
    const handled1 = router.handle(req1, res1);
    req1.emit('data', Buffer.from(body));
    req1.emit('end');
    await handled1;
    expect(res1._status).toBe(200);
    expect(res1._body).toContain('"type":"conversation"');

    // Second turn from the SAME IP within CHAT_MIN_INTERVAL_MS → throttled 429.
    const req2 = routerReq('POST', '/dashboard/api/chat', headers);
    const res2 = routerRes();
    const handled2 = router.handle(req2, res2);
    req2.emit('data', Buffer.from(body));
    req2.emit('end');
    await handled2;
    expect(res2._status).toBe(429);
    // The throttle short-circuits before the SSE stream opens.
    expect(res2._body).not.toContain('"type":"conversation"');
  });
});
