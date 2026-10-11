/**
 * Cookie-authenticated state-changing dashboard requests must be same-origin
 * + JSON (packages/relay/src/dashboard/csrf-guard.ts). A same-host page on a
 * different port is same-SITE (SameSite=Strict still sends the cookie) but not
 * same-origin, so it must be rejected. Bearer clients are unaffected.
 */
import { createServer, request, type Server } from 'http';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AddressInfo } from 'net';
import { DashboardRouter } from '@gossip/relay/dashboard/routes';
import { DashboardAuth } from '@gossip/relay/dashboard/auth';
import { checkCookieRequest } from '@gossip/relay/dashboard/csrf-guard';
import type { IncomingMessage } from 'http';

let root: string;
let server: Server;
let port: number;
let key: string;
let cookie: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gossip-csrf-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  const auth = new DashboardAuth();
  auth.init();
  key = auth.getKey();
  cookie = `dashboard_session=${auth.createSession(key)}`;
  const router = new DashboardRouter(auth, root, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
  server = createServer((req, res) => { void router.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const body = JSON.stringify({ chat_id: 'chat-x', message: 'hi' });
const json = { 'Content-Type': 'application/json' };

describe('cookie-auth CSRF guard', () => {
  it('rejects a same-host, different-port page (same-site but cross-origin)', async () => {
    const host = `localhost:${port}`;
    expect(await send('POST', '/dashboard/api/bridge', { ...json, cookie, host, origin: `http://localhost:${port + 1}` }, body)).toBe(403);
    expect(await send('POST', '/dashboard/api/bridge', { ...json, cookie, host, origin: 'http://evil.example' }, body)).toBe(403);
    expect(await send('POST', '/dashboard/api/bridge', { ...json, cookie, host, origin: 'null' }, body)).toBe(403);
  });

  it('rejects cookie POSTs with neither Origin nor Sec-Fetch-Site: same-origin', async () => {
    expect(await send('POST', '/dashboard/api/bridge', { ...json, cookie }, body)).toBe(403);
    expect(await send('POST', '/dashboard/api/bridge', { ...json, cookie, 'sec-fetch-site': 'same-site' }, body)).toBe(403);
  });

  it('requires application/json for same-origin cookie writes (no simple-request bodies)', async () => {
    const origin = `http://127.0.0.1:${port}`;
    expect(await send('POST', '/dashboard/api/bridge', { cookie, origin, 'Content-Type': 'text/plain' }, body)).toBe(415);
    expect(await send('POST', '/dashboard/api/bridge', { cookie, origin }, body)).toBe(415);
  });

  // One accepted POST per test: allowChatTurn throttles per IP (fresh router per test).
  it('accepts same-origin JSON cookie writes (matching Origin)', async () => {
    expect(await send('POST', '/dashboard/api/bridge', { ...json, cookie, origin: `http://127.0.0.1:${port}` }, body)).toBe(202);
  });

  it('accepts same-origin JSON cookie writes (Sec-Fetch-Site when Origin is absent)', async () => {
    expect(await send('POST', '/dashboard/api/bridge', { ...json, cookie, 'sec-fetch-site': 'same-origin' }, body)).toBe(202);
  });

  it('guards every cookie-auth write route (answers, codex-chat, skills/bind, findings/archive)', async () => {
    const evil = { ...json, cookie, origin: `http://localhost:${port + 1}`, host: `localhost:${port}` };
    const answer = JSON.stringify({ chat_id: 'chat-x', answer: { qid: 'q', responses: [] } });
    expect(await send('POST', '/dashboard/api/bridge', evil, answer)).toBe(403);
    expect(await send('POST', '/dashboard/api/codex-chat', evil, '{}')).toBe(403);
    expect(await send('POST', '/dashboard/api/skills/bind', evil, '{}')).toBe(403);
    expect(await send('POST', '/dashboard/api/findings/archive', evil, '{}')).toBe(403);
    expect(await send('POST', '/dashboard/api/bridge/mirror', evil, '{"frames":[]}')).toBe(403);
  });

  it('leaves safe methods and Bearer clients alone', async () => {
    const evil = { cookie, origin: 'http://evil.example' };
    expect(await send('GET', '/dashboard/api/auth/check', evil)).toBe(200);
    expect(await send('POST', '/dashboard/api/bridge', { authorization: `Bearer ${key}`, 'Content-Type': 'text/plain' }, body)).toBe(202);
  });
});

describe('checkCookieRequest (unit)', () => {
  const req = (method: string, headers: Record<string, string>): IncomingMessage =>
    ({ method, headers } as unknown as IncomingMessage);
  it('matches Origin against the request Host exactly', () => {
    expect(checkCookieRequest(req('POST', { host: 'localhost:24420', origin: 'http://localhost:24420', 'content-type': 'application/json; charset=utf-8' })).ok).toBe(true);
    expect(checkCookieRequest(req('POST', { host: 'localhost:24420', origin: 'http://localhost:24421', 'content-type': 'application/json' })).ok).toBe(false);
    expect(checkCookieRequest(req('POST', { host: 'localhost:24420', origin: 'http://localhost:24420.evil.example', 'content-type': 'application/json' })).ok).toBe(false);
    expect(checkCookieRequest(req('POST', { origin: 'http://localhost', 'content-type': 'application/json' })).ok).toBe(false);
    expect(checkCookieRequest(req('POST', { host: 'localhost', origin: 'http://localhost', 'content-length': '0' })).ok).toBe(true);
  });
});
