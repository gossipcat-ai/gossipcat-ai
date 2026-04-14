/**
 * HTTP File Bridge — real-time tool proxy for closed-toolchain remote agents.
 *
 * Spec: docs/specs/2026-04-14-http-file-bridge.md
 *
 * This module owns: lifecycle (listen/close), auth (bearer tokens, TTL),
 * routing, pre-body Content-Length check, per-token rate-limiter wiring,
 * JSON-lines logging. Endpoint bodies live in http-bridge-handlers.ts so
 * each file stays under the project's 300-LOC cap.
 *
 * Dispatch-time wiring (token issuance, prompt injection, revoke on cleanup)
 * lives in dispatch-pipeline.ts (PR-C).
 */

import * as http from 'http';
import * as https from 'https';
import { createHash, randomUUID } from 'crypto';
import { appendFile, mkdir } from 'fs/promises';
import { resolve, join, relative, dirname } from 'path';
import { canonicalizeForBoundary, validatePathInScope } from '@gossip/tools';
import { RateLimiter } from './rate-limiter';
import {
  BRIDGE_VERSION,
  BYTES_PER_MIN,
  RPS_BRIDGE_INFO_IP,
  RPS_GREP,
  RPS_READ,
  RPS_RUN_TESTS,
  RPS_WRITE,
  MAX_FILE_BYTES,
  WINDOW_MS,
  HandlerCtx,
  TokenRecord,
  handleBridgeInfo,
  handleFileGrep,
  handleFileList,
  handleFileRead,
  handleFileWrite,
  handleRunTests,
  handleSentinel,
} from './http-bridge-handlers';

const TOKEN_HASH_PREFIX = 12; // 48-bit log key

// ─── Public interfaces ─────────────────────────────────────────────────────

export interface HttpBridgeServer {
  listen(tunnelInterface: string): Promise<{ url: string }>;
  issueToken(opts: {
    taskId: string;
    scope: string;
    writeMode: 'read' | 'scoped' | 'worktree';
    ttlSeconds: number;
  }): { token: string; sentinel: string };
  revoke(taskId: string): void;
  close(): Promise<void>;
}

export interface HttpBridgeServerOptions {
  projectRoot: string;
  remoteAccess?: boolean;
  tlsCert?: { cert: Buffer; key: Buffer };
  /** Override .gossip/bridge.log path (tests). */
  logPath?: string;
}

export class BridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeConfigError';
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createHttpBridgeServer(opts: HttpBridgeServerOptions): HttpBridgeServer {
  if (opts.remoteAccess && !opts.tlsCert) {
    throw new BridgeConfigError(
      'remoteAccess=true requires tlsCert to be configured (cert + key Buffers)',
    );
  }
  return new HttpBridgeServerImpl(opts);
}

class HttpBridgeServerImpl implements HttpBridgeServer {
  private server?: http.Server | https.Server;

  private readonly tokens = new Map<string, TokenRecord>();
  private readonly tokensByTask = new Map<string, string>();
  private readonly pendingLogs = new Set<Promise<void>>();

  private readonly limRead = new RateLimiter(WINDOW_MS, RPS_READ);
  private readonly limWrite = new RateLimiter(WINDOW_MS, RPS_WRITE);
  private readonly limGrep = new RateLimiter(WINDOW_MS, RPS_GREP);
  private readonly limRunTests = new RateLimiter(WINDOW_MS, RPS_RUN_TESTS);
  private readonly limBridgeInfo = new RateLimiter(WINDOW_MS, RPS_BRIDGE_INFO_IP);
  private readonly limBytesRead = new RateLimiter(WINDOW_MS, BYTES_PER_MIN);
  private readonly limBytesWrite = new RateLimiter(WINDOW_MS, BYTES_PER_MIN);

  private readonly projectRoot: string;
  private readonly logPath: string;
  private readonly useTls: boolean;
  private readonly tlsCert?: { cert: Buffer; key: Buffer };
  private readonly remoteAccess: boolean;

  constructor(opts: HttpBridgeServerOptions) {
    this.projectRoot = resolve(opts.projectRoot);
    this.logPath = opts.logPath ?? join(this.projectRoot, '.gossip', 'bridge.log');
    this.remoteAccess = !!opts.remoteAccess;
    this.useTls = !!opts.tlsCert;
    this.tlsCert = opts.tlsCert;
  }

  async listen(tunnelInterface: string): Promise<{ url: string }> {
    const bindHost = this.remoteAccess ? tunnelInterface : '127.0.0.1';
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Attach version header BEFORE any response — every status carries it.
      res.setHeader('X-Bridge-Version', String(BRIDGE_VERSION));
      this.route(req, res).catch((err) => {
        if (!res.headersSent) {
          this.sendJson(res, 500, { error: 'internal_error', code: 'internal_error', message: String(err?.message ?? err) });
        }
      });
    };
    this.server = this.useTls && this.tlsCert
      ? https.createServer({ cert: this.tlsCert.cert, key: this.tlsCert.key }, handler)
      : http.createServer(handler);
    await new Promise<void>((resolveOk, rejectErr) => {
      this.server!.once('error', rejectErr);
      this.server!.listen(0, bindHost, () => resolveOk());
    });
    const addr = this.server!.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind HTTP bridge server');
    const scheme = this.useTls ? 'https' : 'http';
    return { url: `${scheme}://${bindHost}:${addr.port}` };
  }

  issueToken(opts: {
    taskId: string;
    scope: string;
    writeMode: 'read' | 'scoped' | 'worktree';
    ttlSeconds: number;
  }): { token: string; sentinel: string } {
    // crypto.randomUUID() — never Math.random (spec §Authentication).
    const token = randomUUID();
    const sentinel = randomUUID();
    const scopeAbs = canonicalizeForBoundary(resolve(this.projectRoot, opts.scope));
    const rootAbs = canonicalizeForBoundary(this.projectRoot);
    if (!validatePathInScope(rootAbs, scopeAbs)) {
      throw new BridgeConfigError(`bridgeScope "${opts.scope}" escapes projectRoot`);
    }
    const rec: TokenRecord = {
      token,
      taskId: opts.taskId,
      scope: scopeAbs,
      scopeRel: relative(this.projectRoot, scopeAbs) || '.',
      writeMode: opts.writeMode,
      expiresAt: Date.now() + opts.ttlSeconds * 1000,
      sentinel,
    };
    this.tokens.set(token, rec);
    const prior = this.tokensByTask.get(opts.taskId);
    if (prior && prior !== token) this.tokens.delete(prior);
    this.tokensByTask.set(opts.taskId, token);
    return { token, sentinel };
  }

  revoke(taskId: string): void {
    const token = this.tokensByTask.get(taskId);
    if (token) this.tokens.delete(token);
    this.tokensByTask.delete(taskId);
  }

  async close(): Promise<void> {
    this.tokens.clear();
    this.tokensByTask.clear();
    if (this.server) {
      await new Promise<void>((resolveOk) => this.server!.close(() => resolveOk()));
      this.server = undefined;
    }
    if (this.pendingLogs.size > 0) await Promise.all([...this.pendingLogs]);
  }

  // ─── Routing ───────────────────────────────────────────────────────────────

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Pre-auth IP-keyed endpoint.
    if (method === 'GET' && url.startsWith('/bridge-info')) {
      return handleBridgeInfo(this.ctx(), req, res, started, this.ipKey(req));
    }

    // Pre-body Content-Length check — MUST fire before any data listener.
    // express.json({limit:…}) reads the body and then rejects; that defeats
    // the point (spec §Pre-implementation code review #5c).
    if (method === 'POST' && url.startsWith('/file-write')) {
      const lenHdr = req.headers['content-length'];
      const len = lenHdr ? Number(lenHdr) : NaN;
      if (Number.isFinite(len) && len > MAX_FILE_BYTES) {
        this.sendJson(res, 413, { error: 'payload_too_large', code: 'payload_too_large', message: `Content-Length ${len} exceeds 10MB cap` });
        req.destroy();
        this.logEvent({ started, req, status: 413, path: url, bytesRead: 0, bytesWritten: 0, token: undefined });
        return;
      }
    }

    const token = this.extractBearer(req);
    const auth = this.authenticate(token);
    if (!auth.ok) {
      this.sendJson(res, 401, { error: 'unauthorized', code: auth.code, message: auth.message });
      this.logEvent({ started, req, status: 401, path: url, bytesRead: 0, bytesWritten: 0, token });
      return;
    }
    const rec = auth.rec;
    const ctx = this.ctx();

    try {
      if (method === 'GET' && url.startsWith('/sentinel')) return await handleSentinel(ctx, req, res, rec, started);
      if (method !== 'POST') {
        this.sendJson(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed', message: `Use POST for ${url}` });
        this.logEvent({ started, req, status: 405, path: url, bytesRead: 0, bytesWritten: 0, token });
        return;
      }
      if (url.startsWith('/file-read'))  return await handleFileRead(ctx, req, res, rec, started);
      if (url.startsWith('/file-write')) return await handleFileWrite(ctx, req, res, rec, started);
      if (url.startsWith('/file-list'))  return await handleFileList(ctx, req, res, rec, started);
      if (url.startsWith('/file-grep'))  return await handleFileGrep(ctx, req, res, rec, started);
      if (url.startsWith('/run-tests'))  return await handleRunTests(ctx, req, res, rec, started);
      this.sendJson(res, 404, { error: 'not_found', code: 'not_found', message: `Unknown path: ${url}` });
      this.logEvent({ started, req, status: 404, path: url, bytesRead: 0, bytesWritten: 0, token });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) this.sendJson(res, 500, { error: 'internal_error', code: 'internal_error', message: msg });
      this.logEvent({ started, req, status: 500, path: url, bytesRead: 0, bytesWritten: 0, token });
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private ctx(): HandlerCtx {
    return {
      projectRoot: this.projectRoot,
      limRead: this.limRead,
      limWrite: this.limWrite,
      limGrep: this.limGrep,
      limRunTests: this.limRunTests,
      limBridgeInfo: this.limBridgeInfo,
      limBytesRead: this.limBytesRead,
      limBytesWrite: this.limBytesWrite,
      sendJson: (res, status, body) => this.sendJson(res, status, body),
      errBody: (error, code, message) => ({ error, code, message }),
      send429: (res) => this.send429(res),
      logEvent: (e) => this.logEvent(e),
    };
  }

  private extractBearer(req: http.IncomingMessage): string | undefined {
    const h = req.headers['authorization'];
    if (!h || typeof h !== 'string') return undefined;
    const m = /^Bearer\s+(\S+)$/.exec(h);
    return m?.[1];
  }

  private authenticate(token: string | undefined):
    | { ok: true; rec: TokenRecord }
    | { ok: false; code: string; message: string } {
    if (!token) return { ok: false, code: 'token_missing', message: 'missing Bearer token' };
    const rec = this.tokens.get(token);
    if (!rec) return { ok: false, code: 'token_invalid', message: 'unknown token' };
    if (Date.now() > rec.expiresAt) {
      this.tokens.delete(token);
      this.tokensByTask.delete(rec.taskId);
      return { ok: false, code: 'token_expired', message: 'token expired' };
    }
    return { ok: true, rec };
  }

  private send429(res: http.ServerResponse): void {
    res.setHeader('Retry-After', '60');
    this.sendJson(res, 429, {
      error: 'too_many_requests',
      code: 'too_many_requests',
      message: 'rate limit exceeded; retry after 60s',
      retry_after: 60,
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }

  private ipKey(req: http.IncomingMessage): string {
    // remoteAddress = direct peer. We do NOT honour X-Forwarded-For because
    // the bridge binds to loopback or a tunnel endpoint — a forwarded header
    // would be attacker-controlled.
    return req.socket.remoteAddress ?? 'unknown';
  }

  private logEvent(e: {
    started: number;
    req: http.IncomingMessage;
    status: number;
    path: string;
    bytesRead: number;
    bytesWritten: number;
    token: string | undefined;
  }): void {
    const entry = {
      timestamp: new Date().toISOString(),
      taskId: e.token ? this.tokens.get(e.token)?.taskId ?? null : null,
      tokenHash: e.token ? createHash('sha256').update(e.token).digest('hex').slice(0, TOKEN_HASH_PREFIX) : null,
      method: e.req.method ?? 'GET',
      path: e.path,
      status: e.status,
      bytesRead: e.bytesRead,
      bytesWritten: e.bytesWritten,
      durationMs: Date.now() - e.started,
    };
    // Fire-and-forget with tracking so close() can drain pending writes.
    const p = mkdir(dirname(this.logPath), { recursive: true })
      .catch(() => { /* ignore */ })
      .then(() => appendFile(this.logPath, JSON.stringify(entry) + '\n'))
      .catch(() => { /* ignore */ })
      .then(() => { this.pendingLogs.delete(p); });
    this.pendingLogs.add(p);
  }
}
