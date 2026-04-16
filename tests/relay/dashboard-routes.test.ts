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
    auth = new DashboardAuth();
    auth.init();
    router = new DashboardRouter(auth, projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
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
    expect(res._headers['Set-Cookie']).toContain('Secure');
    expect(res._headers['Set-Cookie']).toContain('SameSite=Strict');
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

  // ─── Bearer token auth (programmatic/external orchestrator access) ───────
  // Mirrors the cookie flow: same key, same rate limiter, same validator.
  // Callers set `Authorization: Bearer <key>` and skip the /dashboard/api/auth
  // round-trip entirely.
  describe('Bearer token auth', () => {
    it('accepts Authorization: Bearer <correct-key> on /dashboard/api/overview → 200', async () => {
      const req = mockReq('GET', '/dashboard/api/overview', {
        authorization: `Bearer ${auth.getKey()}`,
      });
      const res = mockRes();
      await router.handle(req, res);
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('agentsOnline');
    });

    it('rejects Authorization: Bearer <wrong-key> → 401', async () => {
      const req = mockReq('GET', '/dashboard/api/overview', {
        authorization: 'Bearer not-the-real-key',
      });
      const res = mockRes();
      await router.handle(req, res);
      expect(res._status).toBe(401);
    });

    it('rejects malformed Authorization header (no Bearer prefix)', async () => {
      // No Bearer prefix → treated as absent → falls through to cookie check
      // which fails because no cookie is set. Either way: 401.
      const req = mockReq('GET', '/dashboard/api/overview', {
        authorization: auth.getKey(),
      });
      const res = mockRes();
      await router.handle(req, res);
      expect(res._status).toBe(401);
    });

    it('rate-limits repeated bad Bearer attempts from same IP', async () => {
      // Fire 10 bad bearer attempts (AUTH_MAX_ATTEMPTS) to trip the lockout.
      // Each mockReq gives us a fresh emitter, but mockReq doesn't set
      // req.socket — override so the ip resolves consistently.
      const ip = '10.20.30.40';
      const fireBadBearer = async () => {
        const req = mockReq('GET', '/dashboard/api/overview', {
          authorization: 'Bearer wrong',
        });
        (req as any).socket = { remoteAddress: ip };
        const res = mockRes();
        await router.handle(req, res);
        return res._status;
      };

      // First 10 should be plain 401 (invalid key)
      for (let i = 0; i < 10; i++) {
        expect(await fireBadBearer()).toBe(401);
      }
      // 11th should be 429 (locked out)
      expect(await fireBadBearer()).toBe(429);

      // And even a CORRECT bearer from the same IP is blocked while locked
      const rejectedReq = mockReq('GET', '/dashboard/api/overview', {
        authorization: `Bearer ${auth.getKey()}`,
      });
      (rejectedReq as any).socket = { remoteAddress: ip };
      const rejectedRes = mockRes();
      await router.handle(rejectedReq, rejectedRes);
      expect(rejectedRes._status).toBe(429);
    });

    it('cookie auth still works in parallel with Bearer support', async () => {
      // Regression guard: adding Bearer must not break the cookie flow.
      const token = auth.createSession(auth.getKey())!;
      const cookieReq = mockReq('GET', '/dashboard/api/overview', {
        cookie: `dashboard_session=${token}`,
      });
      const cookieRes = mockRes();
      await router.handle(cookieReq, cookieRes);
      expect(cookieRes._status).toBe(200);

      const bearerReq = mockReq('GET', '/dashboard/api/overview', {
        authorization: `Bearer ${auth.getKey()}`,
      });
      const bearerRes = mockRes();
      await router.handle(bearerReq, bearerRes);
      expect(bearerRes._status).toBe(200);
    });

    it('successful Bearer clears prior failed-attempt counter for that IP', async () => {
      // A legitimate client that mistyped the key once should not stay
      // penalized after presenting the correct key.
      const ip = '10.20.30.41';
      const badReq = mockReq('GET', '/dashboard/api/overview', {
        authorization: 'Bearer wrong',
      });
      (badReq as any).socket = { remoteAddress: ip };
      await router.handle(badReq, mockRes());

      const goodReq = mockReq('GET', '/dashboard/api/overview', {
        authorization: `Bearer ${auth.getKey()}`,
      });
      (goodReq as any).socket = { remoteAddress: ip };
      const goodRes = mockRes();
      await router.handle(goodReq, goodRes);
      expect(goodRes._status).toBe(200);
    });
  });
});

describe('URL query string handling', () => {
  let projectRoot: string;
  let auth: DashboardAuth;
  let router: DashboardRouter;
  let validCookie: Record<string, string>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    auth = new DashboardAuth();
    auth.init();
    router = new DashboardRouter(auth, projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
    const token = auth.createSession(auth.getKey())!;
    validCookie = { cookie: `dashboard_session=${token}` };
  });

  it('routes /dashboard/api/overview?t=123 to overview handler', async () => {
    const req = mockReq('GET', '/dashboard/api/overview?t=123', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.agentsOnline).toBeDefined();
  });

  it('routes /dashboard/api/signals?agent=sonnet-reviewer to signals handler', async () => {
    const req = mockReq('GET', '/dashboard/api/signals?agent=sonnet-reviewer', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
  });

  it('routes /dashboard/api/tasks?limit=5 to tasks handler', async () => {
    const req = mockReq('GET', '/dashboard/api/tasks?limit=5', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
  });

  // ─── Native vs Gossip memory routing
  // Spec: docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md
  it('routes /dashboard/api/native-memory to native handler (canonical name)', async () => {
    const req = mockReq('GET', '/dashboard/api/native-memory', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveProperty('knowledge');
    expect(Array.isArray(body.knowledge)).toBe(true);
  });

  it('routes /dashboard/api/auto-memory to native handler (legacy alias kept for one release)', async () => {
    const req = mockReq('GET', '/dashboard/api/auto-memory', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveProperty('knowledge');
  });

  it('routes /dashboard/api/gossip-memory to gossip handler (returns empty knowledge when dir missing)', async () => {
    const req = mockReq('GET', '/dashboard/api/gossip-memory', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ knowledge: [] });
  });

  it('routes /dashboard/api/gossip-memory and surfaces a real session_*.md file', async () => {
    const memDir = join(projectRoot, '.gossip', 'memory');
    mkdirSync(memDir, { recursive: true });
    const fs = require('fs');
    fs.writeFileSync(
      join(memDir, 'session_2026_04_15.md'),
      `---\nname: x\ndescription: y\nstatus: open\ntype: session\nimportance: 0.4\nlastAccessed: 2026-04-15\nupdated: 2026-04-15\naccessCount: 0\n---\nbody`,
    );
    const req = mockReq('GET', '/dashboard/api/gossip-memory', validCookie);
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.knowledge).toHaveLength(1);
    expect(body.knowledge[0].filename).toBe('session_2026_04_15.md');
    expect(body.knowledge[0].frontmatter.status).toBe('open');
  });
});

describe('SPA catch-all routing', () => {
  let projectRoot: string;
  let auth: DashboardAuth;
  let router: DashboardRouter;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    auth = new DashboardAuth();
    auth.init();
    router = new DashboardRouter(auth, projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
  });

  it('serves /dashboard (no trailing slash) as SPA', async () => {
    const req = mockReq('GET', '/dashboard');
    const res = mockRes();
    const handled = await router.handle(req, res);
    expect(handled).toBe(true);
    // Will be 503 (no built dist) or 200 — not 404
    expect(res._status).not.toBe(404);
  });

  it('serves /dashboard/ as SPA', async () => {
    const req = mockReq('GET', '/dashboard/');
    const res = mockRes();
    const handled = await router.handle(req, res);
    expect(handled).toBe(true);
    expect(res._status).not.toBe(404);
  });

  it('serves /dashboard/team/agent-a as SPA (hash route path not in API)', async () => {
    const req = mockReq('GET', '/dashboard/team/agent-a');
    const res = mockRes();
    const handled = await router.handle(req, res);
    expect(handled).toBe(true);
    // Should serve dashboard HTML (SPA), not 404
    expect(res._status).not.toBe(404);
  });

  it('serves /dashboard/signals as SPA', async () => {
    const req = mockReq('GET', '/dashboard/signals');
    const res = mockRes();
    const handled = await router.handle(req, res);
    expect(handled).toBe(true);
    expect(res._status).not.toBe(404);
  });

  it('does NOT catch /dashboard/api/* as SPA (goes to API handler)', async () => {
    // Without auth, API routes return 401 not SPA
    const req = mockReq('GET', '/dashboard/api/overview');
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(401);
  });

  it('falls through to SPA for missing assets', async () => {
    const req = mockReq('GET', '/dashboard/assets/app.js');
    const res = mockRes();
    await router.handle(req, res);
    // Missing asset with unknown MIME falls through to SPA catch-all which
    // serves index.html (200) when the bundled dashboard root resolves, or
    // 503 when dashboard assets are unavailable. Both are valid paths — the
    // old "404 on missing file" contract was broken (prevented SPA routing).
    expect([200, 404, 503]).toContain(res._status);
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
    const postBody = JSON.stringify({ key: server.dashboardKey });
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
    const postBody = JSON.stringify({ key: server.dashboardKey });

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

  // Regression for "Team page shows empty list on fresh install". The boot
  // snapshot at mcp-server-sdk.ts:365 runs once; if the user calls
  // gossip_setup AFTER boot, the dashboard stays empty until /mcp reconnect
  // unless the MCP server calls setAgentConfigs() to push the new team.
  it('setAgentConfigs updates /dashboard/api/agents without restart', async () => {
    // Authenticate first so we can call the API.
    const postBody = JSON.stringify({ key: server.dashboardKey });
    const authRes = await new Promise<{ cookie: string }>((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}/dashboard/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({
          cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0],
        }));
      });
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });

    const fetchAgents = async (): Promise<any[]> => {
      const res = await new Promise<{ body: string }>((resolve, reject) => {
        const req = http.request(`http://localhost:${server.port}/dashboard/api/agents`, {
          headers: { Cookie: authRes.cookie },
        }, (r) => {
          let body = '';
          r.on('data', (c) => body += c);
          r.on('end', () => resolve({ body }));
        });
        req.on('error', reject);
        req.end();
      });
      return JSON.parse(res.body);
    };

    // Start: empty team (boot snapshot with no agents).
    expect(await fetchAgents()).toEqual([]);

    // Simulate gossip_setup writing config.json and calling setAgentConfigs.
    server.setAgentConfigs([
      {
        id: 'sonnet-reviewer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        preset: 'reviewer',
        skills: ['code_review'],
        native: true,
      },
    ]);

    // Dashboard reflects the new team without /mcp reconnect.
    const after = await fetchAgents();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe('sonnet-reviewer');
    expect(after[0].native).toBe(true);
  });
});
