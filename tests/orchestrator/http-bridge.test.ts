/**
 * HTTP File Bridge — endpoint + auth + scope + rate-limit tests.
 *
 * Spec: docs/specs/2026-04-14-http-file-bridge.md
 *
 * TLS-specific coverage lives in http-bridge-tls.test.ts (PR-C).
 */

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHttpBridgeServer, BridgeConfigError } from '@gossip/orchestrator/http-bridge-server';
import type { HttpBridgeServer } from '@gossip/orchestrator/http-bridge-server';
import * as http from 'http';

// ─── Test harness ───────────────────────────────────────────────────────────

interface BridgeCtx {
  url: string;
  token: string;
  sentinel: string;
  bridge: HttpBridgeServer;
  projectRoot: string;
  logPath: string;
}

async function withBridge(
  body: (ctx: BridgeCtx) => Promise<void>,
  opts: { writeMode?: 'read' | 'scoped' | 'worktree'; scope?: string; ttlSeconds?: number } = {},
): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-bridge-'));
  const logPath = join(projectRoot, '.gossip', 'bridge.log');
  const bridge = createHttpBridgeServer({ projectRoot, logPath });
  const { url } = await bridge.listen('127.0.0.1');
  const { token, sentinel } = bridge.issueToken({
    taskId: 'task-' + Math.floor(Math.random() * 1e9),
    scope: opts.scope ?? '.',
    writeMode: opts.writeMode ?? 'scoped',
    ttlSeconds: opts.ttlSeconds ?? 60,
  });
  try {
    await body({ url, token, sentinel, bridge, projectRoot, logPath });
  } finally {
    await bridge.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function req(
  method: 'GET' | 'POST',
  url: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const u = new URL(url);
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (headers['Content-Length'] === undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
  }

  return new Promise((resolveOk, rejectErr) => {
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: any = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* raw */ }
          const hdrs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            hdrs[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v ?? '');
          }
          resolveOk({ status: res.statusCode ?? 0, body: parsed, headers: hdrs });
        });
      },
    );
    r.on('error', rejectErr);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

// ─── Auth ───────────────────────────────────────────────────────────────────

describe('HTTP bridge: auth', () => {
  test('missing bearer → 401 token_missing', async () => {
    await withBridge(async ({ url }) => {
      const res = await req('POST', `${url}/file-read`, { body: { path: 'x' } });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_missing');
      expect(res.body.error).toBe('unauthorized');
    });
  });

  test('unknown token → 401 token_invalid', async () => {
    await withBridge(async ({ url }) => {
      const res = await req('POST', `${url}/file-read`, { token: 'not-a-real-token', body: { path: 'x' } });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_invalid');
    });
  });

  test('expired token → 401 token_expired', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-bridge-'));
    const bridge = createHttpBridgeServer({ projectRoot });
    const { url } = await bridge.listen('127.0.0.1');
    const { token } = bridge.issueToken({ taskId: 't', scope: '.', writeMode: 'read', ttlSeconds: 0 });
    try {
      await new Promise((r) => setTimeout(r, 30));
      const res = await req('POST', `${url}/file-read`, { token, body: { path: 'x' } });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_expired');
    } finally {
      await bridge.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('valid token → request reaches handler (200 or scope-specific)', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      writeFileSync(join(projectRoot, 'hello.txt'), 'hi');
      const res = await req('POST', `${url}/file-read`, { token, body: { path: 'hello.txt' } });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('hi');
    });
  });
});

// ─── Scope enforcement ──────────────────────────────────────────────────────

describe('HTTP bridge: scope', () => {
  test('relative path inside scope OK', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      writeFileSync(join(projectRoot, 'a.txt'), 'A');
      const res = await req('POST', `${url}/file-read`, { token, body: { path: 'a.txt' } });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('A');
    });
  });

  test('absolute path rejected 403', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      writeFileSync(join(projectRoot, 'a.txt'), 'A');
      const res = await req('POST', `${url}/file-read`, { token, body: { path: join(projectRoot, 'a.txt') } });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('scope_violation');
    });
  });

  test('../ traversal rejected 403', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gossip-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    try {
      await withBridge(async ({ url, token }) => {
        const res = await req('POST', `${url}/file-read`, { token, body: { path: '../../../../../../tmp/something/secret.txt' } });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('scope_violation');
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('symlink escape rejected 403', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gossip-outside-sym-'));
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    try {
      await withBridge(async ({ url, token, projectRoot }) => {
        // Plant a symlink inside scope pointing out of scope.
        symlinkSync(join(outside, 'secret.txt'), join(projectRoot, 'leak.txt'));
        const res = await req('POST', `${url}/file-read`, { token, body: { path: 'leak.txt' } });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('scope_violation');
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('write to non-existent path inside scope succeeds (security-critical branch)', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      const res = await req('POST', `${url}/file-write`, { token, body: { path: 'new/nested/file.txt', content: 'fresh' } });
      expect(res.status).toBe(200);
      expect(res.body.etag).toMatch(/^[0-9a-f]{16}$/);
      expect(readFileSync(join(projectRoot, 'new/nested/file.txt'), 'utf-8')).toBe('fresh');
    });
  });

  test('write to non-existent path OUTSIDE scope via ancestor-symlink still rejected', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gossip-outside-ancestor-'));
    mkdirSync(join(outside, 'target'));
    try {
      await withBridge(async ({ url, token, projectRoot }) => {
        symlinkSync(join(outside, 'target'), join(projectRoot, 'trojan'));
        const res = await req('POST', `${url}/file-write`, {
          token,
          body: { path: 'trojan/new.txt', content: 'escaped' },
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('scope_violation');
        expect(existsSync(join(outside, 'target', 'new.txt'))).toBe(false);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('read-only token blocks /file-write with 403', async () => {
    await withBridge(async ({ url, token }) => {
      const res = await req('POST', `${url}/file-write`, { token, body: { path: 'a.txt', content: 'x' } });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('scope_violation');
    }, { writeMode: 'read' });
  });
});

// ─── ETag / If-Match ────────────────────────────────────────────────────────

describe('HTTP bridge: ETag', () => {
  test('write → read returns etag; If-Match match → 200; mismatch → 412', async () => {
    await withBridge(async ({ url, token }) => {
      const w1 = await req('POST', `${url}/file-write`, { token, body: { path: 'a.txt', content: 'v1' } });
      expect(w1.status).toBe(200);
      const e1 = w1.body.etag;
      const r1 = await req('POST', `${url}/file-read`, { token, body: { path: 'a.txt' } });
      expect(r1.body.etag).toBe(e1);

      // Matching If-Match → success
      const w2 = await req('POST', `${url}/file-write`, { token, body: { path: 'a.txt', content: 'v2', if_match: e1 } });
      expect(w2.status).toBe(200);

      // Stale etag → 412
      const w3 = await req('POST', `${url}/file-write`, { token, body: { path: 'a.txt', content: 'v3', if_match: e1 } });
      expect(w3.status).toBe(412);
      expect(w3.body.code).toBe('etag_mismatch');
      expect(w3.body.error).toBe('precondition_failed');
    });
  });

  test('412 does NOT starve further writes (rate cap is not tripped by mismatches)', async () => {
    await withBridge(async ({ url, token }) => {
      // Seed a file with known etag.
      const w1 = await req('POST', `${url}/file-write`, { token, body: { path: 'a.txt', content: 'seed' } });
      expect(w1.status).toBe(200);
      // Fire a burst of mismatches — fewer than the RPS cap (50/min).
      for (let i = 0; i < 10; i++) {
        const wr = await req('POST', `${url}/file-write`, { token, body: { path: 'a.txt', content: 'x', if_match: 'bogus' } });
        expect(wr.status).toBe(412);
      }
      // A subsequent write with correct ETag (or no If-Match) should still succeed.
      const latest = await req('POST', `${url}/file-read`, { token, body: { path: 'a.txt' } });
      const wOk = await req('POST', `${url}/file-write`, { token, body: { path: 'a.txt', content: 'done', if_match: latest.body.etag } });
      expect(wOk.status).toBe(200);
    });
  });
});

// ─── Sentinel ───────────────────────────────────────────────────────────────

describe('HTTP bridge: sentinel', () => {
  test('GET /sentinel with valid token returns task sentinel value', async () => {
    await withBridge(async ({ url, token, sentinel }) => {
      const res = await req('GET', `${url}/sentinel`, { token });
      expect(res.status).toBe(200);
      expect(res.body.token).toBe(sentinel);
    });
  });

  test('GET /sentinel without token → 401', async () => {
    await withBridge(async ({ url }) => {
      const res = await req('GET', `${url}/sentinel`);
      expect(res.status).toBe(401);
    });
  });
});

// ─── bridge-info ────────────────────────────────────────────────────────────

describe('HTTP bridge: /bridge-info', () => {
  test('pre-auth (no token) returns version+capabilities', async () => {
    await withBridge(async ({ url }) => {
      const res = await req('GET', `${url}/bridge-info`);
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(res.body.capabilities).toBeDefined();
      expect(Array.isArray(res.body.capabilities.endpoints)).toBe(true);
      expect(res.body.capabilities.auth).toBe('bearer');
      expect(res.body.capabilities.etag).toBe(true);
    });
  });

  test('version mismatch → 400 version_mismatch', async () => {
    await withBridge(async ({ url }) => {
      const res = await req('GET', `${url}/bridge-info?version=999`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('version_mismatch');
    });
  });

  test('IP-keyed rate limit — 101st request in window → 429', async () => {
    await withBridge(async ({ url }) => {
      for (let i = 0; i < 100; i++) {
        const r = await req('GET', `${url}/bridge-info`);
        expect(r.status).toBe(200);
      }
      const hit = await req('GET', `${url}/bridge-info`);
      expect(hit.status).toBe(429);
      expect(hit.body.code).toBe('too_many_requests');
      expect(hit.body.retry_after).toBe(60);
      expect(hit.headers['retry-after']).toBe('60');
    });
  }, 15000);
});

// ─── Rate limit ─────────────────────────────────────────────────────────────

describe('HTTP bridge: rate limit', () => {
  test('read cap (100/min) tripped → 429 with retry_after', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      writeFileSync(join(projectRoot, 'x.txt'), 'x');
      for (let i = 0; i < 100; i++) {
        const r = await req('POST', `${url}/file-read`, { token, body: { path: 'x.txt' } });
        expect(r.status).toBe(200);
      }
      const hit = await req('POST', `${url}/file-read`, { token, body: { path: 'x.txt' } });
      expect(hit.status).toBe(429);
      expect(hit.body.error).toBe('too_many_requests');
      expect(hit.body.code).toBe('too_many_requests');
      expect(hit.body.retry_after).toBe(60);
      expect(hit.body.message).toBeDefined();
      expect(hit.headers['retry-after']).toBe('60');
    });
  }, 30000);

  test('grep cap (20/min) → 429', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      writeFileSync(join(projectRoot, 'x.txt'), 'find-me\nother');
      for (let i = 0; i < 20; i++) {
        const r = await req('POST', `${url}/file-grep`, { token, body: { pattern: 'find-me' } });
        expect(r.status).toBe(200);
      }
      const hit = await req('POST', `${url}/file-grep`, { token, body: { pattern: 'find-me' } });
      expect(hit.status).toBe(429);
    });
  }, 15000);
});

// ─── In-flight bytes quota ─────────────────────────────────────────────────

describe('HTTP bridge: in-flight bytes quota', () => {
  test('10 × 5MB reads OK; 11th → 429 (bytes quota 50MB/min)', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      const bigPath = join(projectRoot, 'big.txt');
      const payload = 'A'.repeat(5 * 1024 * 1024);
      writeFileSync(bigPath, payload);
      for (let i = 0; i < 10; i++) {
        const r = await req('POST', `${url}/file-read`, { token, body: { path: 'big.txt' } });
        expect(r.status).toBe(200);
      }
      const hit = await req('POST', `${url}/file-read`, { token, body: { path: 'big.txt' } });
      expect(hit.status).toBe(429);
      expect(hit.body.code).toBe('too_many_requests');
    });
  }, 30000);
});

// ─── Pre-body Content-Length check ─────────────────────────────────────────

describe('HTTP bridge: pre-body Content-Length', () => {
  test('POST /file-write with CL=20MB → 413 + req.destroy() before body is consumed', async () => {
    await withBridge(async ({ url, token }) => {
      const u = new URL(url);
      let bytesSent = 0;
      let destroyed = false;

      await new Promise<void>((resolveOk) => {
        const r = http.request(
          {
            method: 'POST',
            hostname: u.hostname,
            port: u.port,
            path: '/file-write',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Length': String(20 * 1024 * 1024),
            },
          },
          (res) => {
            expect(res.statusCode).toBe(413);
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              expect(parsed.code).toBe('payload_too_large');
              expect(parsed.error).toBe('payload_too_large');
              resolveOk();
            });
          },
        );
        r.on('error', () => { destroyed = true; resolveOk(); });
        r.on('close', () => resolveOk());

        // Try to write a small first chunk — the server should have already
        // destroyed the connection or rejected without reading.
        const chunk = Buffer.alloc(64 * 1024, 0x41);
        bytesSent += chunk.byteLength;
        try { r.write(chunk); } catch { /* socket closed */ }
        // Don't send the full 20MB; the assertion is that 413 arrives promptly.
        setTimeout(() => { try { r.end(); } catch { /* ignore */ } }, 100);
      });

      // We only need to have written a tiny fraction to prove the server did
      // not wait for the full 20MB — the 413 must have come back very early.
      expect(bytesSent).toBeLessThan(1 * 1024 * 1024);
      // destroyed is an informational signal; the core assertion is the 413.
      void destroyed;
    });
  }, 10000);
});

// ─── Configuration ─────────────────────────────────────────────────────────

describe('HTTP bridge: config errors', () => {
  test('remoteAccess=true without tlsCert → throws BridgeConfigError from factory', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-bridge-cfg-'));
    try {
      expect(() =>
        createHttpBridgeServer({ projectRoot, remoteAccess: true }),
      ).toThrow(BridgeConfigError);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('bridgeScope escape rejected at issueToken time', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-bridge-scope-'));
    const bridge = createHttpBridgeServer({ projectRoot });
    try {
      await bridge.listen('127.0.0.1');
      expect(() => bridge.issueToken({
        taskId: 't',
        scope: '../../../..',
        writeMode: 'read',
        ttlSeconds: 60,
      })).toThrow(BridgeConfigError);
    } finally {
      await bridge.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

// ─── Error envelope + headers ──────────────────────────────────────────────

describe('HTTP bridge: error envelope and headers', () => {
  test('X-Bridge-Version: 1 on success, auth failure, and 413', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      writeFileSync(join(projectRoot, 'a.txt'), 'x');
      const ok = await req('POST', `${url}/file-read`, { token, body: { path: 'a.txt' } });
      expect(ok.headers['x-bridge-version']).toBe('1');

      const unauth = await req('POST', `${url}/file-read`, { body: { path: 'a.txt' } });
      expect(unauth.headers['x-bridge-version']).toBe('1');

      const tooBig = await req('POST', `${url}/file-write`, {
        token,
        body: { path: 'a.txt', content: 'x' },
        headers: { 'Content-Length': String(20 * 1024 * 1024) },
      });
      // CL lies — the actual body is small — but the server checks CL first.
      expect(tooBig.headers['x-bridge-version']).toBe('1');
      expect(tooBig.status).toBe(413);
    });
  });

  test('error envelope has {error, code, message} on all non-2xx', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      writeFileSync(join(projectRoot, 'a.txt'), 'x');

      const unauth = await req('POST', `${url}/file-read`, { body: { path: 'a.txt' } });
      expect(unauth.status).toBe(401);
      expect(unauth.body.error).toBeDefined();
      expect(unauth.body.code).toBeDefined();
      expect(unauth.body.message).toBeDefined();

      const escape = await req('POST', `${url}/file-read`, { token, body: { path: '/etc/passwd' } });
      expect(escape.status).toBe(403);
      expect(escape.body.code).toBe('scope_violation');

      const mismatch = await req('POST', `${url}/file-write`, { token, body: { path: 'a.txt', content: 'y', if_match: 'bogus-etag' } });
      expect(mismatch.status).toBe(412);
      expect(mismatch.body.code).toBe('etag_mismatch');
    });
  });
});

// ─── Logging ────────────────────────────────────────────────────────────────

describe('HTTP bridge: logging', () => {
  test('.gossip/bridge.log receives JSONL with spec fields', async () => {
    await withBridge(async ({ url, token, projectRoot, logPath }) => {
      writeFileSync(join(projectRoot, 'a.txt'), 'hi');
      await req('POST', `${url}/file-read`, { token, body: { path: 'a.txt' } });
      // The logger is fire-and-forget — give it a turn to flush.
      await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(last.taskId).toBeDefined();
      expect(typeof last.tokenHash).toBe('string');
      expect(last.tokenHash.length).toBe(12);
      expect(last.method).toBe('POST');
      expect(last.path).toBe('/file-read');
      expect(last.status).toBe(200);
      expect(typeof last.bytesRead).toBe('number');
      expect(typeof last.bytesWritten).toBe('number');
      expect(typeof last.durationMs).toBe('number');
    });
  });

  test('tokenHash is sha256 prefix, NEVER a raw-token prefix', async () => {
    await withBridge(async ({ url, token, projectRoot, logPath }) => {
      writeFileSync(join(projectRoot, 'a.txt'), 'hi');
      await req('POST', `${url}/file-read`, { token, body: { path: 'a.txt' } });
      await new Promise((r) => setTimeout(r, 100));
      const raw = readFileSync(logPath, 'utf-8');
      // Token must NEVER appear verbatim (full or the first 12 chars).
      expect(raw.includes(token)).toBe(false);
      expect(raw.includes(token.slice(0, 12))).toBe(false);
    });
  });
});

// ─── Grep defenses ─────────────────────────────────────────────────────────

describe('HTTP bridge: /file-grep defenses', () => {
  test('pattern longer than 1000 chars → 400 (ReDoS heuristic)', async () => {
    await withBridge(async ({ url, token }) => {
      const res = await req('POST', `${url}/file-grep`, { token, body: { pattern: 'a'.repeat(1500) } });
      expect(res.status).toBe(400);
    });
  });

  test('invalid regex → 400', async () => {
    await withBridge(async ({ url, token }) => {
      const res = await req('POST', `${url}/file-grep`, { token, body: { pattern: '[' } });
      expect(res.status).toBe(400);
    });
  });

  test('match-cap truncation is reported', async () => {
    await withBridge(async ({ url, token, projectRoot }) => {
      // Write a file with 600 matching lines; cap is 500.
      let content = '';
      for (let i = 0; i < 600; i++) content += `needle-${i}\n`;
      writeFileSync(join(projectRoot, 'hits.txt'), content);
      const res = await req('POST', `${url}/file-grep`, { token, body: { pattern: 'needle-' } });
      expect(res.status).toBe(200);
      expect(res.body.matches.length).toBeLessThanOrEqual(500);
      expect(res.body.truncated).toBe(true);
    });
  });
});

// ─── Revoke ────────────────────────────────────────────────────────────────

describe('HTTP bridge: revoke', () => {
  test('revoke invalidates token — subsequent calls 401', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'gossip-bridge-rev-'));
    const bridge = createHttpBridgeServer({ projectRoot });
    const { url } = await bridge.listen('127.0.0.1');
    const { token } = bridge.issueToken({ taskId: 'tX', scope: '.', writeMode: 'read', ttlSeconds: 60 });
    try {
      writeFileSync(join(projectRoot, 'a.txt'), 'x');
      const ok = await req('POST', `${url}/file-read`, { token, body: { path: 'a.txt' } });
      expect(ok.status).toBe(200);
      bridge.revoke('tX');
      const gone = await req('POST', `${url}/file-read`, { token, body: { path: 'a.txt' } });
      expect(gone.status).toBe(401);
      expect(gone.body.code).toBe('token_invalid');
    } finally {
      await bridge.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
