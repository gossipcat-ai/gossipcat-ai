import { DashboardRouter } from '@gossip/relay/dashboard/routes';
import { DashboardAuth } from '@gossip/relay/dashboard/auth';
import { IncomingMessage, ServerResponse } from 'http';
import { mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = new EventEmitter() as any;
  res._status = 200;
  res._headers = {};
  res._body = '';
  res.writeHead = (code: number, headers?: Record<string, string>) => {
    res._status = code;
    if (headers) Object.assign(res._headers, headers);
    return res;
  };
  res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
  res.write = () => true;
  res.end = (body?: string) => { res._body = body ?? ''; };
  res.destroy = () => {};
  return res;
}

/** POST a JSON body through the router and resolve the response. */
async function post(router: DashboardRouter, url: string, body: unknown, bearer: string): Promise<ReturnType<typeof mockRes>> {
  const req = mockReq('POST', url, { authorization: `Bearer ${bearer}` });
  const res = mockRes();
  const handled = router.handle(req, res);
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await handled;
  return res;
}

describe('POST /dashboard/api/bridge/mirror', () => {
  let projectRoot: string;
  let auth: DashboardAuth;
  let router: DashboardRouter;
  let key: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-mirror-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    auth = new DashboardAuth();
    auth.init();
    key = auth.getKey();
    router = new DashboardRouter(auth, projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
    // Open a dashboard stream so 'chatA' is a valid mirror target.
    router.registerBridgeSink(() => true);
  });

  async function openStream(chatId: string): Promise<void> {
    const r = await post(router, '/dashboard/api/bridge', { chat_id: chatId, message: 'open' }, key);
    expect(r._status).toBe(202);
  }

  it('accepts a valid batch with 202 for an open stream', async () => {
    await openStream('chatA');
    const res = await post(router, '/dashboard/api/bridge/mirror', {
      chat_id: 'chatA',
      frames: [{ role: 'user', text: 'hi' }, { role: 'activity', text: 'bash · ls' }],
    }, key);
    expect(res._status).toBe(202);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, chat_id: 'chatA', frames: 2 });
  });

  it('rejects a single bad frame in an otherwise-valid batch with 400', async () => {
    await openStream('chatA');
    const res = await post(router, '/dashboard/api/bridge/mirror', {
      chat_id: 'chatA',
      frames: [{ role: 'user', text: 'good' }, { role: 'nope', text: 'bad' }],
    }, key);
    expect(res._status).toBe(400);
  });

  it('requires auth (401 without Bearer/session)', async () => {
    const req = mockReq('POST', '/dashboard/api/bridge/mirror');
    const res = mockRes();
    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(JSON.stringify({ frames: [] })));
    req.emit('end');
    await handled;
    expect(res._status).toBe(401);
  });

  it('dedicated mirror bucket does NOT consume the human-chat allowChatTurn bucket (P1#2)', async () => {
    // The human chat throttle (allowChatTurn) is per-IP with a 1s interval; the
    // /bridge route uses it. The mirror route uses a SEPARATE per-chat_id bucket.
    // Spy on allowChatTurn to prove the mirror route never touches it: a hook
    // burst on /mirror must leave the chat bucket completely uncalled.
    await openStream('chatA'); // this DOES call allowChatTurn (the /bridge route)
    const chatSpy = jest.spyOn(router as any, 'allowChatTurn');
    for (let i = 0; i < 8; i++) {
      const r = await post(router, '/dashboard/api/bridge/mirror', { chat_id: 'chatA', frames: [{ role: 'activity', text: `t${i}` }] }, key);
      // Mirror bucket may 429 a too-fast burst, but it must be the MIRROR bucket
      // doing it — never allowChatTurn.
      expect([202, 429]).toContain(r._status);
    }
    expect(chatSpy).not.toHaveBeenCalled();
    chatSpy.mockRestore();
  });

  it('mirror bucket is per-chat_id (P1#2): distinct chat_ids have independent buckets', async () => {
    // Drive the bucket directly to avoid the unrelated per-IP /bridge open
    // throttle. allowMirrorTurn is keyed by chat_id: the SAME key throttles on
    // a rapid second call; a DIFFERENT key does not.
    const allow = (key: string) => (router as any).allowMirrorTurn(key);
    expect(allow('chatA')).toBe(true);
    expect(allow('chatA')).toBe(false); // same key, too fast → throttled
    expect(allow('chatB')).toBe(true);  // different key → its own bucket, allowed
  });

  it('rejects an empty-string chat_id with 400, not a silent no-chat_id fallback (f13)', async () => {
    const res = await post(router, '/dashboard/api/bridge/mirror', {
      chat_id: '',
      frames: [{ role: 'activity', text: 'x' }],
    }, key);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toMatchObject({ error: 'invalid chat_id' });
  });

  it('rejects a malformed chat_id at the route before bucket derivation (f15/f16)', async () => {
    const res = await post(router, '/dashboard/api/bridge/mirror', {
      chat_id: 'bad id!',
      frames: [{ role: 'activity', text: 'x' }],
    }, key);
    expect(res._status).toBe(400);
  });

  it('derives the rate bucket from the VALIDATED chat_id (f15)', async () => {
    await openStream('chatA');
    const spy = jest.spyOn(router as any, 'allowMirrorTurn');
    await post(router, '/dashboard/api/bridge/mirror', {
      chat_id: 'chatA',
      frames: [{ role: 'user', text: 'hi' }],
    }, key);
    // The bucket key is the validated chat_id itself, never a raw/coerced value.
    expect(spy).toHaveBeenCalledWith('chatA');
    spy.mockRestore();
  });

  it('keys the bucket by validated session_id when chat_id is absent (f11/f3)', async () => {
    const spy = jest.spyOn(router as any, 'allowMirrorTurn');
    await post(router, '/dashboard/api/bridge/mirror', {
      session_id: 'sess-7',
      frames: [{ role: 'activity', text: 'terminal' }],
    }, key);
    // Distinct sessions get distinct buckets — keyed by the session, not a single
    // global '_nochatid'.
    expect(spy).toHaveBeenCalledWith('_sess:sess-7');
    spy.mockRestore();
  });

  it('falls back to a single anonymous bucket only when neither id is present', async () => {
    const spy = jest.spyOn(router as any, 'allowMirrorTurn');
    await post(router, '/dashboard/api/bridge/mirror', {
      frames: [{ role: 'activity', text: 'anon' }],
    }, key);
    expect(spy).toHaveBeenCalledWith('_nochatid');
    spy.mockRestore();
  });

  it('hard-caps the mirrorLastTurn map under a flood of distinct keys (f18)', () => {
    const allow = (k: string) => (router as any).allowMirrorTurn(k);
    // Push well past the 1000 hard cap with distinct fresh keys. The soft >100
    // prune reaps nothing (all fresh), so the hard cap must bound the map.
    for (let i = 0; i < 1300; i++) allow(`k${i}`);
    expect((router as any).mirrorLastTurn.size).toBeLessThanOrEqual(1000);
  });
});
