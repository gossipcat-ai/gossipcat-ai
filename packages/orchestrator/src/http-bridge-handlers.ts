/**
 * HTTP File Bridge — endpoint handlers.
 *
 * Extracted from http-bridge-server.ts to keep the orchestrator module under
 * the project's 300-LOC ceiling. All handlers receive a HandlerCtx struct that
 * bundles rate limiters, project root, and response-sending helpers so the
 * server class stays focused on listen/auth/routing.
 *
 * Spec: docs/specs/2026-04-14-http-file-bridge.md
 */

import * as http from 'http';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { readFile, writeFile, stat, readdir, mkdir } from 'fs/promises';
import { statSync } from 'fs';
import { resolve, join, relative, dirname } from 'path';
import { canonicalizeForBoundary, validatePathInScope } from '@gossip/tools';
import { RateLimiter } from './rate-limiter';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const WINDOW_MS = 60_000;
export const RPS_READ = 100;
export const RPS_WRITE = 50;
export const RPS_GREP = 20;
export const RPS_RUN_TESTS = 10;
export const RPS_BRIDGE_INFO_IP = 100;
export const BYTES_PER_MIN = 50 * 1024 * 1024;
export const GREP_MATCH_CAP = 500;
export const GREP_TIMEOUT_MS = 2000;
export const GREP_PATTERN_MAX = 1000;
export const RUN_TESTS_TIMEOUT_MS = 120_000;
export const BRIDGE_VERSION = 1;

export interface TokenRecord {
  token: string;
  taskId: string;
  scope: string;       // absolute canonicalized directory (trailing slash)
  scopeRel: string;    // project-relative display string
  writeMode: 'read' | 'scoped' | 'worktree';
  expiresAt: number;
  sentinel: string;
}

export interface HandlerCtx {
  projectRoot: string;
  limRead: RateLimiter;
  limWrite: RateLimiter;
  limGrep: RateLimiter;
  limRunTests: RateLimiter;
  limBridgeInfo: RateLimiter;
  limBytesRead: RateLimiter;
  limBytesWrite: RateLimiter;
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  errBody: (error: string, code: string, message: string) => { error: string; code: string; message: string };
  send429: (res: http.ServerResponse) => void;
  logEvent: (e: { started: number; req: http.IncomingMessage; status: number; path: string; bytesRead: number; bytesWritten: number; token: string | undefined }) => void;
}

// ─── Utility ────────────────────────────────────────────────────────────────

export function computeEtag(mtime: number, size: number, content: Buffer): string {
  // spec line 89: sha256(mtime + '|' + size + '|' + content_hash)[:16]
  const contentHash = createHash('sha256').update(content).digest('hex');
  return createHash('sha256').update(`${mtime}|${size}|${contentHash}`).digest('hex').slice(0, 16);
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return true;
  return false;
}

function resolveInScope(rec: TokenRecord, reqPath: string): { ok: true; path: string } | { ok: false; msg: string } {
  if (reqPath.startsWith('/')) return { ok: false, msg: 'absolute paths are rejected' };
  const joined = resolve(rec.scope, reqPath);
  const canonical = canonicalizeForBoundary(joined);
  if (!validatePathInScope(rec.scope, canonical)) {
    return { ok: false, msg: `path "${reqPath}" is outside scope "${rec.scopeRel}"` };
  }
  return { ok: true, path: joined };
}

async function readJsonBody(
  req: http.IncomingMessage,
  cap: number,
): Promise<{ value: Record<string, unknown> } | { err: 'too_large' | 'invalid_json'; msg: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > cap) return { err: 'too_large', msg: `body exceeds ${cap} bytes` };
    chunks.push(buf);
  }
  try {
    const text = Buffer.concat(chunks).toString('utf-8');
    return { value: text ? JSON.parse(text) : {} };
  } catch (err) {
    return { err: 'invalid_json', msg: err instanceof Error ? err.message : 'parse error' };
  }
}

function replyBodyErr(
  ctx: HandlerCtx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rec: TokenRecord,
  started: number,
  path: string,
  body: { err: 'too_large' | 'invalid_json'; msg: string },
): void {
  if (body.err === 'too_large') {
    ctx.sendJson(res, 413, ctx.errBody('payload_too_large', 'payload_too_large', body.msg));
    ctx.logEvent({ started, req, status: 413, path, bytesRead: 0, bytesWritten: 0, token: rec.token });
  } else {
    ctx.sendJson(res, 400, ctx.errBody('bad_request', 'bad_request', body.msg));
    ctx.logEvent({ started, req, status: 400, path, bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
}

function reply403(ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, rec: TokenRecord, started: number, path: string, msg: string): void {
  ctx.sendJson(res, 403, ctx.errBody('forbidden', 'scope_violation', msg));
  ctx.logEvent({ started, req, status: 403, path, bytesRead: 0, bytesWritten: 0, token: rec.token });
}

function reply429(ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, rec: TokenRecord, started: number, path: string): void {
  ctx.send429(res);
  ctx.logEvent({ started, req, status: 429, path, bytesRead: 0, bytesWritten: 0, token: rec.token });
}

// ─── Handlers ──────────────────────────────────────────────────────────────

export async function handleBridgeInfo(
  ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, started: number, ip: string,
): Promise<void> {
  if (!ctx.limBridgeInfo.record(ip)) {
    ctx.send429(res);
    ctx.logEvent({ started, req, status: 429, path: '/bridge-info', bytesRead: 0, bytesWritten: 0, token: undefined });
    return;
  }
  const u = new URL(req.url ?? '/', 'http://x');
  const clientVer = u.searchParams.get('version');
  if (clientVer !== null && clientVer !== String(BRIDGE_VERSION)) {
    ctx.sendJson(res, 400, ctx.errBody(
      'bad_request', 'version_mismatch',
      `Client version ${clientVer} not supported; server version ${BRIDGE_VERSION}`,
    ));
    ctx.logEvent({ started, req, status: 400, path: '/bridge-info', bytesRead: 0, bytesWritten: 0, token: undefined });
    return;
  }
  ctx.sendJson(res, 200, {
    version: BRIDGE_VERSION,
    capabilities: {
      endpoints: ['/file-read', '/file-write', '/file-list', '/file-grep', '/run-tests', '/sentinel'],
      auth: 'bearer',
      etag: true,
      max_file_bytes: MAX_FILE_BYTES,
    },
  });
  ctx.logEvent({ started, req, status: 200, path: '/bridge-info', bytesRead: 0, bytesWritten: 0, token: undefined });
}

export async function handleSentinel(
  ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, rec: TokenRecord, started: number,
): Promise<void> {
  if (!ctx.limRead.record(`sentinel:${rec.token}`)) return reply429(ctx, req, res, rec, started, '/sentinel');
  ctx.sendJson(res, 200, { token: rec.sentinel });
  ctx.logEvent({ started, req, status: 200, path: '/sentinel', bytesRead: 0, bytesWritten: 0, token: rec.token });
}

export async function handleFileRead(
  ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, rec: TokenRecord, started: number,
): Promise<void> {
  if (!ctx.limRead.record(`read:${rec.token}`)) return reply429(ctx, req, res, rec, started, '/file-read');
  const body = await readJsonBody(req, MAX_FILE_BYTES);
  if ('err' in body) return replyBodyErr(ctx, req, res, rec, started, '/file-read', body);
  const path = typeof body.value?.path === 'string' ? body.value.path : '';
  if (!path) {
    ctx.sendJson(res, 400, ctx.errBody('bad_request', 'bad_request', 'path is required'));
    return ctx.logEvent({ started, req, status: 400, path: '/file-read', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
  const abs = resolveInScope(rec, path);
  if (!abs.ok) return reply403(ctx, req, res, rec, started, '/file-read', abs.msg);

  let fileSize: number;
  let mtime: number;
  try {
    const st = await stat(abs.path);
    if (!st.isFile()) {
      ctx.sendJson(res, 400, ctx.errBody('bad_request', 'bad_request', 'path is not a regular file'));
      return ctx.logEvent({ started, req, status: 400, path: '/file-read', bytesRead: 0, bytesWritten: 0, token: rec.token });
    }
    fileSize = st.size;
    mtime = st.mtimeMs;
  } catch {
    ctx.sendJson(res, 404, ctx.errBody('not_found', 'not_found', 'file not found'));
    return ctx.logEvent({ started, req, status: 404, path: '/file-read', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
  if (fileSize > MAX_FILE_BYTES) {
    ctx.sendJson(res, 413, {
      ...ctx.errBody('payload_too_large', 'payload_too_large', `File ${fileSize} exceeds 10MB cap`),
      hint: 'use the git project bridge for bulk materialization',
    });
    return ctx.logEvent({ started, req, status: 413, path: '/file-read', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
  if (!ctx.limBytesRead.record(`bytes-read:${rec.token}`, fileSize)) {
    return reply429(ctx, req, res, rec, started, '/file-read');
  }
  const buf = await readFile(abs.path);
  const encoding = looksBinary(buf) ? 'base64' : 'utf-8';
  const content = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf-8');
  const etag = computeEtag(mtime, fileSize, buf);
  ctx.sendJson(res, 200, { content, etag, encoding });
  ctx.logEvent({ started, req, status: 200, path: '/file-read', bytesRead: fileSize, bytesWritten: 0, token: rec.token });
}

export async function handleFileWrite(
  ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, rec: TokenRecord, started: number,
): Promise<void> {
  if (rec.writeMode === 'read') {
    ctx.sendJson(res, 403, ctx.errBody('forbidden', 'scope_violation', 'token is read-only'));
    return ctx.logEvent({ started, req, status: 403, path: '/file-write', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
  if (!ctx.limWrite.record(`write:${rec.token}`)) return reply429(ctx, req, res, rec, started, '/file-write');

  const body = await readJsonBody(req, MAX_FILE_BYTES);
  if ('err' in body) return replyBodyErr(ctx, req, res, rec, started, '/file-write', body);
  const path = typeof body.value?.path === 'string' ? body.value.path : '';
  const content = typeof body.value?.content === 'string' ? body.value.content : '';
  const ifMatch = typeof body.value?.if_match === 'string' ? body.value.if_match : undefined;
  if (!path) {
    ctx.sendJson(res, 400, ctx.errBody('bad_request', 'bad_request', 'path is required'));
    return ctx.logEvent({ started, req, status: 400, path: '/file-write', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
  const abs = resolveInScope(rec, path);
  if (!abs.ok) return reply403(ctx, req, res, rec, started, '/file-write', abs.msg);

  const buf = Buffer.from(content, 'utf-8');
  if (buf.byteLength > MAX_FILE_BYTES) {
    ctx.sendJson(res, 413, ctx.errBody('payload_too_large', 'payload_too_large',
      `Content ${buf.byteLength} exceeds 10MB cap`));
    return ctx.logEvent({ started, req, status: 413, path: '/file-write', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }

  let currentEtag: string | null = null;
  try {
    const st = await stat(abs.path);
    if (st.isFile()) {
      const existing = await readFile(abs.path);
      currentEtag = computeEtag(st.mtimeMs, st.size, existing);
    }
  } catch { /* new path */ }

  if (ifMatch !== undefined && currentEtag !== null && ifMatch !== currentEtag) {
    ctx.sendJson(res, 412, ctx.errBody('precondition_failed', 'etag_mismatch',
      `ETag mismatch: expected ${ifMatch}, actual ${currentEtag}`));
    return ctx.logEvent({ started, req, status: 412, path: '/file-write', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }

  if (!ctx.limBytesWrite.record(`bytes-write:${rec.token}`, buf.byteLength)) {
    return reply429(ctx, req, res, rec, started, '/file-write');
  }
  try { await mkdir(dirname(abs.path), { recursive: true }); } catch { /* best-effort */ }
  await writeFile(abs.path, buf);
  const st2 = await stat(abs.path);
  const newEtag = computeEtag(st2.mtimeMs, st2.size, buf);
  ctx.sendJson(res, 200, { etag: newEtag });
  ctx.logEvent({ started, req, status: 200, path: '/file-write', bytesRead: 0, bytesWritten: buf.byteLength, token: rec.token });
}

export async function handleFileList(
  ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, rec: TokenRecord, started: number,
): Promise<void> {
  if (!ctx.limRead.record(`list:${rec.token}`)) return reply429(ctx, req, res, rec, started, '/file-list');
  const body = await readJsonBody(req, 1024 * 16);
  if ('err' in body) return replyBodyErr(ctx, req, res, rec, started, '/file-list', body);
  const dir = typeof body.value?.dir === 'string' ? body.value.dir : '.';
  const depth = Math.min(typeof body.value?.depth === 'number' ? body.value.depth : 1, 5);
  const abs = resolveInScope(rec, dir);
  if (!abs.ok) return reply403(ctx, req, res, rec, started, '/file-list', abs.msg);
  const entries: Array<{ path: string; type: 'file' | 'dir'; size: number }> = [];
  await walkList(abs.path, depth, (p, type, size) => {
    entries.push({ path: relative(ctx.projectRoot, p), type, size });
  });
  ctx.sendJson(res, 200, { entries });
  ctx.logEvent({ started, req, status: 200, path: '/file-list', bytesRead: 0, bytesWritten: 0, token: rec.token });
}

export async function handleFileGrep(
  ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, rec: TokenRecord, started: number,
): Promise<void> {
  if (!ctx.limGrep.record(`grep:${rec.token}`)) return reply429(ctx, req, res, rec, started, '/file-grep');
  const body = await readJsonBody(req, 1024 * 16);
  if ('err' in body) return replyBodyErr(ctx, req, res, rec, started, '/file-grep', body);
  const pattern = typeof body.value?.pattern === 'string' ? body.value.pattern : '';
  const glob = typeof body.value?.glob === 'string' ? body.value.glob : undefined;
  if (!pattern) {
    ctx.sendJson(res, 400, ctx.errBody('bad_request', 'bad_request', 'pattern is required'));
    return ctx.logEvent({ started, req, status: 400, path: '/file-grep', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
  if (pattern.length > GREP_PATTERN_MAX) {
    ctx.sendJson(res, 400, ctx.errBody('bad_request', 'bad_request',
      `Pattern longer than ${GREP_PATTERN_MAX} chars — rejected as potential ReDoS`));
    return ctx.logEvent({ started, req, status: 400, path: '/file-grep', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
  let regex: RegExp;
  try { regex = new RegExp(pattern); }
  catch {
    ctx.sendJson(res, 400, ctx.errBody('bad_request', 'bad_request', 'invalid regex'));
    return ctx.logEvent({ started, req, status: 400, path: '/file-grep', bytesRead: 0, bytesWritten: 0, token: rec.token });
  }
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const cancel: { stop: boolean } = { stop: false };
  const workPromise = grepWalk(rec.scope, regex, glob, matches, cancel);
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolveOk) => {
    timer = setTimeout(() => { cancel.stop = true; resolveOk('timeout'); }, GREP_TIMEOUT_MS);
  });
  const outcome = await Promise.race([workPromise.then(() => 'done' as const), timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    ctx.sendJson(res, 200, { matches: matches.slice(0, GREP_MATCH_CAP), truncated: true, reason: 'timeout' });
    ctx.logEvent({ started, req, status: 200, path: '/file-grep', bytesRead: 0, bytesWritten: 0, token: rec.token });
    return;
  }
  const truncated = matches.length >= GREP_MATCH_CAP;
  ctx.sendJson(res, 200, {
    matches: matches.slice(0, GREP_MATCH_CAP),
    ...(truncated ? { truncated: true, reason: 'match_cap' } : {}),
  });
  ctx.logEvent({ started, req, status: 200, path: '/file-grep', bytesRead: 0, bytesWritten: 0, token: rec.token });
}

export async function handleRunTests(
  ctx: HandlerCtx, req: http.IncomingMessage, res: http.ServerResponse, rec: TokenRecord, started: number,
): Promise<void> {
  if (!ctx.limRunTests.record(`run-tests:${rec.token}`)) return reply429(ctx, req, res, rec, started, '/run-tests');
  const body = await readJsonBody(req, 1024 * 16);
  if ('err' in body) return replyBodyErr(ctx, req, res, rec, started, '/run-tests', body);
  const pattern = typeof body.value?.pattern === 'string' ? body.value.pattern : '';
  // spawn — NEVER `exec` or shell interpolation. The `--` separator passes
  // `pattern` as a test-runner arg, not as a shell token.
  const args = ['test'];
  if (pattern) { args.push('--', pattern); }
  const child = spawn('npm', args, {
    cwd: ctx.projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf-8'); if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024); });
  const exitCode = await new Promise<number>((resolveOk) => {
    const tm = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolveOk(124); }, RUN_TESTS_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(tm); resolveOk(code ?? -1); });
    child.on('error', () => { clearTimeout(tm); resolveOk(-1); });
  });
  ctx.sendJson(res, 200, { stdout, stderr, exit_code: exitCode });
  ctx.logEvent({ started, req, status: 200, path: '/run-tests', bytesRead: 0, bytesWritten: 0, token: rec.token });
}

// ─── Walkers ───────────────────────────────────────────────────────────────

async function walkList(
  root: string,
  maxDepth: number,
  visit: (p: string, type: 'file' | 'dir', size: number) => void,
): Promise<void> {
  async function recur(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(dir, name);
      let st;
      try { st = await stat(p); } catch { continue; }
      if (st.isDirectory()) {
        visit(p, 'dir', 0);
        await recur(p, depth + 1);
      } else if (st.isFile()) {
        visit(p, 'file', st.size);
      }
    }
  }
  try {
    const s = statSync(root);
    if (s.isDirectory()) await recur(root, 1);
  } catch { /* nothing */ }
}

async function grepWalk(
  root: string,
  regex: RegExp,
  glob: string | undefined,
  matches: Array<{ path: string; line: number; text: string }>,
  cancel: { stop: boolean },
): Promise<void> {
  const globRegex = glob ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : undefined;
  async function recur(dir: string): Promise<void> {
    if (cancel.stop || matches.length >= GREP_MATCH_CAP) return;
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const name of entries) {
      if (cancel.stop || matches.length >= GREP_MATCH_CAP) return;
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(dir, name);
      let st;
      try { st = await stat(p); } catch { continue; }
      if (st.isDirectory()) {
        await recur(p);
      } else if (st.isFile()) {
        if (globRegex && !globRegex.test(name)) continue;
        let content: string;
        try { content = await readFile(p, 'utf-8'); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (cancel.stop || matches.length >= GREP_MATCH_CAP) return;
          if (regex.test(lines[i])) {
            matches.push({ path: p, line: i + 1, text: lines[i] });
          }
        }
      }
    }
  }
  await recur(root);
}
