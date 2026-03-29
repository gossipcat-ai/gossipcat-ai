import { DashboardRouter } from '@gossip/relay/dashboard/routes';
import { DashboardAuth } from '@gossip/relay/dashboard/auth';
import { RelayServer } from '@gossip/relay';
import { IncomingMessage, ServerResponse } from 'http';
import { mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import http from 'http';

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = headers;
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
  res.end = (body?: string) => { res._body = body ?? ''; };
  return res;
}

describe('DashboardRouter', () => {
  let projectRoot: string;
  let auth: DashboardAuth;
  let router: DashboardRouter;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    auth = new DashboardAuth(projectRoot);
    auth.init();
    router = new DashboardRouter(auth, projectRoot, { agentConfigs: [], relayConnections: 0 });
  });

  it('returns 404 for non-dashboard routes', async () => {
    const req = mockReq('GET', '/other');
    const res = mockRes();
    const handled = await router.handle(req, res);
    expect(handled).toBe(false);
  });

  it('POST /dashboard/api/auth sets session cookie on valid key', async () => {
    const req = mockReq('POST', '/dashboard/api/auth');
    const body = JSON.stringify({ key: auth.getKey() });
    const res = mockRes();

    // Simulate body
    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(body));
    req.emit('end');
    await handled;

    expect(res._status).toBe(200);
    expect(res._headers['Set-Cookie']).toContain('dashboard_session=');
    expect(res._headers['Set-Cookie']).toContain('HttpOnly');
    expect(res._headers['Set-Cookie']).toContain('SameSite=Lax');
  });

  it('POST /dashboard/api/auth rejects invalid key', async () => {
    const req = mockReq('POST', '/dashboard/api/auth');
    const body = JSON.stringify({ key: 'wrong' });
    const res = mockRes();

    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(body));
    req.emit('end');
    await handled;

    expect(res._status).toBe(401);
  });

  it('POST /dashboard/api/auth handles malformed JSON body', async () => {
    const req = mockReq('POST', '/dashboard/api/auth');
    const res = mockRes();
    const handled = router.handle(req, res);
    req.emit('data', Buffer.from('not json at all'));
    req.emit('end');
    await handled;
    expect(res._status).toBe(400);
  });

  it('POST /dashboard/api/auth handles empty body', async () => {
    const req = mockReq('POST', '/dashboard/api/auth');
    const res = mockRes();
    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(''));
    req.emit('end');
    await handled;
    expect(res._status).toBe(400);
  });

  it('POST /dashboard/api/auth handles body missing key field', async () => {
    const req = mockReq('POST', '/dashboard/api/auth');
    const res = mockRes();
    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(JSON.stringify({ password: 'wrong-field' })));
    req.emit('end');
    await handled;
    expect(res._status).toBe(401);
  });

  it('rejects expired session token', async () => {
    // Test with a non-existent token (simulates expired/evicted session)
    const req = mockReq('GET', '/dashboard/api/overview', {
      cookie: 'dashboard_session=expired_fake_token_that_does_not_exist',
    });
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(401);
  });

  it('rejects tampered session cookie', async () => {
    const token = auth.createSession(auth.getKey())!;
    const tampered = token.slice(0, -4) + 'XXXX'; // corrupt last 4 chars
    const req = mockReq('GET', '/dashboard/api/overview', {
      cookie: `dashboard_session=${tampered}`,
    });
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(401);
  });

  it('API routes require valid session', async () => {
    const req = mockReq('GET', '/dashboard/api/overview');
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(401);
  });

  it('API routes work with valid session cookie', async () => {
    const token = auth.createSession(auth.getKey())!;
    const req = mockReq('GET', '/dashboard/api/overview', {
      cookie: `dashboard_session=${token}`,
    });
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveProperty('agentsOnline');
  });
});

describe('RelayServer dashboard integration', () => {
  let server: RelayServer;
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    server = new RelayServer({
      port: 0,
      dashboard: { projectRoot, agentConfigs: [] },
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function request(path: string, options: http.RequestOptions = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}${path}`, options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(options.method === 'POST' ? (options as any)._body : undefined);
    });
  }

  it('serves /health as before', async () => {
    const { status, body } = await request('/health');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('ok');
  });

  it('returns 401 for unauthenticated API', async () => {
    const { status } = await request('/dashboard/api/overview');
    expect(status).toBe(401);
  });

  it('POST /dashboard/api/auth with valid key returns session cookie', async () => {
    const fullKey = require('fs').readFileSync(join(projectRoot, '.gossip', 'dashboard-key'), 'utf-8').trim();
    const postBody = JSON.stringify({ key: fullKey });
    const { status, headers } = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}/dashboard/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers }));
      });
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });
    expect(status).toBe(200);
    expect(headers['set-cookie']?.[0]).toContain('dashboard_session=');
  });

  it('full auth → cookie → API flow', async () => {
    const fullKey = require('fs').readFileSync(join(projectRoot, '.gossip', 'dashboard-key'), 'utf-8').trim();
    const postBody = JSON.stringify({ key: fullKey });

    // Step 1: Authenticate and get cookie
    const authRes = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}/dashboard/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({
          status: res.statusCode!,
          cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0],
        }));
      });
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });
    expect(authRes.status).toBe(200);
    expect(authRes.cookie).toContain('dashboard_session=');

    // Step 2: Use cookie to call API
    const apiRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}/dashboard/api/overview`, {
        headers: { Cookie: authRes.cookie },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(apiRes.status).toBe(200);
    const data = JSON.parse(apiRes.body);
    expect(data).toHaveProperty('agentsOnline');
    expect(data).toHaveProperty('totalSignals');
  });
});
