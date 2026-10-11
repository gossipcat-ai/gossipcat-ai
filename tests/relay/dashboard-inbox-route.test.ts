/**
 * Route-level: POST /dashboard/api/bridge queues (202) with no live sink, and
 * GET /dashboard/api/bridge/inbox reports per-message status behind auth.
 */
import { DashboardRouter } from '@gossip/relay/dashboard/routes';
import { DashboardAuth } from '@gossip/relay/dashboard/auth';
import type { IncomingMessage, ServerResponse } from 'http';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

type MockRes = ServerResponse & { _status: number; _body: string };

function mockReq(method: string, url: string, headers: Record<string, string>): IncomingMessage {
  const req = new EventEmitter() as unknown as Record<string, unknown>;
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  return req as unknown as IncomingMessage;
}
function mockRes(): MockRes {
  const res = new EventEmitter() as unknown as Record<string, unknown>;
  res._status = 200;
  res._body = '';
  res.writeHead = (code: number) => { res._status = code; return res; };
  res.setHeader = () => {};
  res.write = () => true;
  res.end = (body?: string) => { res._body = body ?? ''; };
  res.destroy = () => {};
  return res as unknown as MockRes;
}

let root: string;
let router: DashboardRouter;
let key: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gossip-inbox-route-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  const auth = new DashboardAuth();
  auth.init();
  key = auth.getKey();
  router = new DashboardRouter(auth, root, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function call(method: string, url: string, body?: unknown, bearer: string = key): Promise<MockRes> {
  const req = mockReq(method, url, { authorization: `Bearer ${bearer}` });
  const res = mockRes();
  const handled = router.handle(req, res);
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await handled;
  return res;
}

it('queues without a sink and exposes status via GET /bridge/inbox', async () => {
  const post = await call('POST', '/dashboard/api/bridge', { chat_id: 'chat-r', message: 'hi' });
  expect(post._status).toBe(202);
  const payload = JSON.parse(post._body);
  expect(payload).toMatchObject({ delivery: 'queued', chat_id: 'chat-r' });

  const get = await call('GET', '/dashboard/api/bridge/inbox?chat_id=chat-r');
  expect(get._status).toBe(200);
  const snap = JSON.parse(get._body);
  expect(snap.link.state).toBe('offline');
  expect(snap.messages).toEqual([expect.objectContaining({ id: payload.inbox_id, status: 'queued' })]);
});

it('GET /bridge/inbox requires auth', async () => {
  const res = await call('GET', '/dashboard/api/bridge/inbox?chat_id=chat-r', undefined, 'wrong-key');
  expect(res._status).toBe(401);
});
