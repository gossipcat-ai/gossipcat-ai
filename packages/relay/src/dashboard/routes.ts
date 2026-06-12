import { IncomingMessage, ServerResponse } from 'http';
import { DashboardAuth } from './auth';
import { handleEventsSSE } from './api-events';
import { overviewHandler } from './api-overview';
import { fleetTrendHandler } from './api-fleet-trend';
import { agentsHandler } from './api-agents';
import { skillsGetHandler, skillsBindHandler } from './api-skills';
import { memoryHandler } from './api-memory';
import { autoMemoryHandler } from './api-native-memory';
import { gossipMemoryHandler } from './api-gossip-memory';
import { consensusHandler } from './api-consensus';
import { consensusFlowHandler, isValidConsensusId } from './api-consensus-flow';
import { signalsHandler } from './api-signals';
import { signalActivityHandler } from './api-signal-activity';
import { findingHandler } from './api-finding';
import { openFindingsHandler } from './api-open-findings';
import { learningsHandler } from './api-learnings';
import { tasksHandler } from './api-tasks';
import { activeTasksHandler } from './api-active-tasks';
import { logsHandler } from './api-logs';
import { violationsHandler } from './api-violations';
import { handleChat } from './api-chat';
import { ChatConversationStore } from './chat-session-store';
import type { ChatbotAgent } from '@gossip/orchestrator';
import { buildCoverageDegradedMessage } from './coverage-degraded-utils';
import { readFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { createHash, timingSafeEqual } from 'crypto';

interface AgentConfigLike {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  skills: string[];
  native?: boolean;
}

/**
 * True when the request reached us over TLS. The relay is its own HTTP server
 * (no bundled TLS termination today), so direct socket detection — a
 * TLSSocket exposes `.encrypted === true` — is the primary signal. We also
 * honor `x-forwarded-proto: https` for the reverse-proxy-in-front case, but
 * only as a secondary check; a plain-HTTP relay never sets it itself.
 *
 * Why this matters (issue #548 item 1): the session cookie was always sent
 * with `Secure`, but the relay serves plain HTTP. Browsers drop a `Secure`
 * cookie on http:// origins (Safari does NOT exempt localhost), so login
 * "succeeded" with a 200 yet every subsequent API call 401'd. Emitting
 * `Secure` only over real TLS fixes that without weakening HTTPS deployments.
 */
export function isRequestSecure(req: IncomingMessage): boolean {
  const socket = req.socket as { encrypted?: boolean } | undefined;
  if (socket?.encrypted === true) return true;
  const xfp = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(xfp) ? xfp[0] : xfp;
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * Build the session Set-Cookie value. `Secure` is included only when the
 * request arrived over TLS — see isRequestSecure. HttpOnly + SameSite=Strict +
 * the 24h Max-Age are unchanged.
 */
export function buildSessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `dashboard_session=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/dashboard',
    'Max-Age=86400',
  ];
  if (secure) attrs.splice(1, 0, 'Secure');
  return attrs.join('; ');
}

interface DashboardContext {
  agentConfigs: AgentConfigLike[];
  relayConnections: number;
  connectedAgentIds: string[];
}

const AUTH_MAX_ATTEMPTS = 10;
const AUTH_LOCKOUT_MS = 60_000; // 1 minute lockout after max attempts
// Idle TTL for never-locked authAttempts entries (count below the lockout
// threshold, lockedUntil still 0). A slow distributed scan never trips a
// lockout, so the expired-lockout sweep alone never reaps these and the map
// grows unbounded. 15 minutes is well past the 1-minute lockout window — long
// enough that a real (bursty) attacker's in-progress count survives, short
// enough that abandoned slow-scan entries fall out promptly.
const AUTH_ATTEMPT_TTL_MS = 15 * 60_000; // 15 minutes
// Hard cap backstop: if the map still exceeds this after a sweep, evict the
// oldest non-locked entries by lastAttemptAt. Active lockouts are never
// evicted — memory safety must not weaken the lockout guarantee.
const AUTH_ATTEMPTS_HARD_CAP = 1000;

interface LegacyRoundWarning { code: string; message: string; agentId?: string }

/**
 * DISK BACK-COMPAT (spec §4 / PR-C): consensus reports persisted by older
 * versions carry the deprecated degraded-mode trio
 * (relayCrossReviewSkipped / coverageDegraded / partialReview) but NO
 * `warnings` array. The warnings channel now SUBSUMES those fields, so when a
 * historical report lacks `warnings`, synthesize equivalent RoundWarnings from
 * the trio at READ time so the dashboard still renders the degraded modes.
 * Reports that already carry `warnings` (written by PR-C+) pass through
 * untouched. Never mutates the legacy fields — only adds `warnings`.
 */
export function normalizeLegacyDegradedFields(report: any): any {
  if (!report || typeof report !== 'object') return report;
  if (Array.isArray(report.warnings) && report.warnings.length > 0) return report;
  const synthesized: LegacyRoundWarning[] = [];
  const cd = report.coverageDegraded;
  if (cd && typeof cd === 'object') {
    synthesized.push({
      code: 'coverage_degraded',
      message: buildCoverageDegradedMessage({
        received: cd.received ?? 0,
        expected: cd.expected ?? 0,
        droppedAgents: Array.isArray(cd.droppedAgents) ? cd.droppedAgents : [],
      }),
    });
  }
  if (Array.isArray(report.relayCrossReviewSkipped)) {
    for (const s of report.relayCrossReviewSkipped) {
      if (s && typeof s === 'object') {
        synthesized.push({
          code: 'cross_review_skipped',
          message: `cross-review skipped: ${s.reason ?? 'unknown'}`,
          ...(typeof s.agentId === 'string' ? { agentId: s.agentId } : {}),
        });
      }
    }
  }
  if (report.partialReview === true) {
    synthesized.push({
      code: 'partial_review',
      message: 'at least one finding received fewer than its target K cross-reviewers',
    });
  }
  if (synthesized.length === 0) return report;
  return { ...report, warnings: synthesized };
}

// Per-route body cap for POST /dashboard/api/chat. Larger than the shared
// MAX_BODY_SIZE (8 KB) because a chat message can be a reasonable paragraph,
// but still tightly bounded as a DoS guard (CORRECTION #6 — parametrize
// readBody, don't bump the shared cap).
const CHAT_MAX_BODY = 64 * 1024; // 64 KB

// Minimum interval between chat turns from one IP — a simple per-IP throttle so
// a single client can't fan out concurrent/rapid turns (each turn can run up to
// maxToolCallsPerTurn tool executions). Mirrors the isIpLockedOut style.
const CHAT_MIN_INTERVAL_MS = 1_000;

/**
 * Resolve the bundled dashboard asset root. Same multi-candidate pattern as
 * rules-loader.ts: try the bundled production layout first, then dev/repo
 * layouts. `projectRoot` is the user's cwd (where .gossip/ lives) — NOT the
 * place where dist-dashboard ships. The first candidate handles the npm
 * install case where dist-dashboard is a sibling of dist-mcp/mcp-server.js.
 */
function resolveDashboardRoot(projectRoot: string): string | null {
  const candidates = [
    resolve(__dirname, '..', 'dist-dashboard'),                  // bundled: dist-mcp/mcp-server.js → ../dist-dashboard
    resolve(__dirname, '..', '..', '..', '..', 'dist-dashboard'), // tsc dev: packages/relay/dist/dashboard → repo-root
    join(projectRoot, 'dist-dashboard'),                          // legacy dev fallback (git-clone running from repo root)
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export class DashboardRouter {
  private authAttempts = new Map<string, { count: number; lockedUntil: number; lastAttemptAt: number }>();
  private dashboardRoot: string | null;
  // Chatbot seam (P2). Null until the app layer injects an agent via
  // setChatbot; a null agent is the graceful-degrade path (handleChat emits an
  // error event rather than 5xx).
  private chatbot: ChatbotAgent | null = null;
  private chatStore = new ChatConversationStore();
  // Per-IP last-chat-turn timestamp for the min-interval throttle.
  private chatLastTurn = new Map<string, number>();

  constructor(
    private auth: DashboardAuth,
    private projectRoot: string,
    private ctx: DashboardContext,
  ) {
    this.dashboardRoot = resolveDashboardRoot(projectRoot);
  }

  /**
   * Inject (or clear) the read-only chatbot agent. Called by the app layer
   * after boot via RelayServer.setChatbot. Passing null disables chat with a
   * graceful-degrade SSE error rather than a hard failure.
   */
  setChatbot(agent: ChatbotAgent | null): void {
    this.chatbot = agent;
  }

  /** Update live context (call when agents connect/disconnect) */
  updateContext(ctx: Partial<DashboardContext>): void {
    if (ctx.agentConfigs !== undefined) this.ctx.agentConfigs = ctx.agentConfigs;
    if (ctx.relayConnections !== undefined) this.ctx.relayConnections = ctx.relayConnections;
    if (ctx.connectedAgentIds !== undefined) this.ctx.connectedAgentIds = ctx.connectedAgentIds;
  }

  /**
   * Handle an HTTP request. Returns true if the route was handled, false otherwise.
   * Caller should only call this for URLs starting with /dashboard.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith('/dashboard')) return false;

    const qIdx = rawUrl.indexOf('?');
    const url = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const query = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)) : null;

    // Auth endpoint — no session required
    if (url === '/dashboard/api/auth' && req.method === 'POST') {
      return this.handleAuth(req, res);
    }

    // All other /dashboard/api/* routes require session OR a valid Bearer key.
    //
    // Two auth flows:
    //   1. Cookie: POST /dashboard/api/auth → Set-Cookie: dashboard_session=…
    //      (web UI; HttpOnly, SameSite=Strict).
    //   2. Bearer: `Authorization: Bearer <key>` (programmatic/external
    //      orchestrators that don't want cookie gymnastics). The key is the
    //      same one the web UI posts — we timing-safe-compare its sha256 to
    //      the in-memory key, matching auth.ts:40's comparison.
    //
    // Bearer failures rate-limit the same way cookie failures do so an
    // attacker can't brute-force via either channel.
    if (url.startsWith('/dashboard/api/')) {
      const bearer = this.extractBearerKey(req);
      if (bearer !== null) {
        const ip = req.socket?.remoteAddress || 'unknown';
        if (this.isIpLockedOut(ip)) {
          this.json(res, 429, { error: 'Too many attempts. Try again later.' });
          return true;
        }
        if (this.validateBearerKey(bearer)) {
          // Successful bearer auth — clear any prior failed-attempt counter
          this.authAttempts.delete(ip);
          return this.handleApi(req, res, url, query);
        }
        // Invalid bearer — bump the same counter cookie-auth uses
        this.recordFailedAuthAttempt(ip);
        this.json(res, 401, { error: 'Unauthorized' });
        return true;
      }
      const token = this.extractSessionToken(req);
      if (!token || !this.auth.validateSession(token)) {
        this.json(res, 401, { error: 'Unauthorized' });
        return true;
      }
      return this.handleApi(req, res, url, query);
    }

    // Static assets (Vite outputs to /assets/ and /dashboard/assets/)
    if (url.startsWith('/dashboard/') && !url.startsWith('/dashboard/api/')) {
      const served = this.serveStaticFile(res, url);
      if (served) return true;
      // SPA catch-all: serve index.html for unmatched routes
      return this.serveDashboard(res);
    }

    if (url === '/dashboard') {
      return this.serveDashboard(res);
    }

    // Root + bare host: redirect to /dashboard. The SPA at /dashboard
    // handles its own auth gate (login form when no session cookie,
    // overview when authed).
    if (url === '/' || url === '') {
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
      return true;
    }

    this.json(res, 404, { error: 'Not found' });
    return true;
  }

  private async handleAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const ip = req.socket?.remoteAddress || 'unknown';
    if (this.isIpLockedOut(ip)) {
      this.json(res, 429, { error: 'Too many attempts. Try again later.' });
      return true;
    }

    // readBody must run INSIDE the try: it rejects on an aborted socket or an
    // oversized body (maxBytes), and an escaped rejection would surface as an
    // unhandled promise rejection rather than a clean HTTP error. A body-read
    // failure is NOT a failed auth attempt — the key was never evaluated, so we
    // do not call recordFailedAuthAttempt here.
    try {
      const body = await readBody(req);
      const { key } = JSON.parse(body);
      const token = this.auth.createSession(key);
      if (!token) {
        this.recordFailedAuthAttempt(ip);
        this.json(res, 401, { error: 'Invalid key' });
        return true;
      }
      // Successful auth — clear attempts
      this.authAttempts.delete(ip);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': buildSessionCookie(token, isRequestSecure(req)),
      });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      this.json(res, 400, { error: 'Invalid request body' });
    }
    return true;
  }

  /**
   * Shared rate-limit check for both cookie and Bearer auth. Pruning runs
   * opportunistically when the map grows past 100 to cap memory on abusive
   * scans without paying the cost on every request.
   */
  private isIpLockedOut(ip: string): boolean {
    const now = Date.now();
    if (this.authAttempts.size > 100) this.sweepAuthAttempts(now);
    const attempt = this.authAttempts.get(ip);
    return !!(attempt && attempt.lockedUntil > now);
  }

  /**
   * Opportunistic, timer-free reaper for the authAttempts map. Runs only when
   * the map crosses 100 entries (called from isIpLockedOut). Removes two
   * classes of dead entry, then applies a hard-cap backstop:
   *   1. Expired lockouts — `lockedUntil > 0 && lockedUntil < now`.
   *   2. Stale never-locked entries — `lockedUntil === 0` and the last attempt
   *      is older than AUTH_ATTEMPT_TTL_MS. These come from slow distributed
   *      scans that never reach AUTH_MAX_ATTEMPTS, so the expired-lockout rule
   *      alone never reaps them and the map grows unbounded.
   * INVARIANT: an ACTIVE lockout (`lockedUntil > now`) is never deleted here,
   * including by the hard-cap backstop — pruning must never shorten a lockout.
   */
  private sweepAuthAttempts(now: number): void {
    for (const [k, v] of this.authAttempts) {
      const expiredLockout = v.lockedUntil > 0 && v.lockedUntil < now;
      const staleNeverLocked = v.lockedUntil === 0 && now - v.lastAttemptAt > AUTH_ATTEMPT_TTL_MS;
      if (expiredLockout || staleNeverLocked) this.authAttempts.delete(k);
    }
    // Backstop against memory exhaustion: if the map is still over the hard cap
    // after the sweep, evict the oldest NON-LOCKED entries (oldest lastAttemptAt
    // first) until back under the cap. Active lockouts are excluded.
    if (this.authAttempts.size > AUTH_ATTEMPTS_HARD_CAP) {
      const evictable = [...this.authAttempts.entries()]
        .filter(([, v]) => !(v.lockedUntil > now))
        .sort((a, b) => a[1].lastAttemptAt - b[1].lastAttemptAt);
      let toEvict = this.authAttempts.size - AUTH_ATTEMPTS_HARD_CAP;
      for (const [k] of evictable) {
        if (toEvict <= 0) break;
        this.authAttempts.delete(k);
        toEvict--;
      }
    }
  }

  /**
   * Per-IP min-interval throttle for chat turns. Returns true (and records the
   * new turn timestamp) when the caller is allowed to proceed; false when the
   * previous turn was too recent. Opportunistic pruning caps the map under
   * abusive scans, same posture as isIpLockedOut.
   */
  private allowChatTurn(ip: string): boolean {
    const now = Date.now();
    if (this.chatLastTurn.size > 100) {
      // Prune entries idle for longer than the throttle window can possibly
      // matter (10x the interval). Pruning at exactly CHAT_MIN_INTERVAL_MS was
      // too aggressive to reap under a fast scan — by the time the map crosses
      // 100, the freshest 100 entries are all within one interval and nothing
      // gets dropped, so the guard never actually reaps. A 10x window keeps the
      // throttle decision intact while letting stale IPs fall out.
      const staleBefore = CHAT_MIN_INTERVAL_MS * 10;
      for (const [k, v] of this.chatLastTurn) {
        if (now - v > staleBefore) this.chatLastTurn.delete(k);
      }
    }
    const last = this.chatLastTurn.get(ip);
    if (last !== undefined && now - last < CHAT_MIN_INTERVAL_MS) return false;
    this.chatLastTurn.set(ip, now);
    return true;
  }

  /**
   * Bump the failed-attempt counter for an IP and start the lockout window
   * once we hit AUTH_MAX_ATTEMPTS. Cookie and Bearer failures share one
   * counter so an attacker can't double-dip.
   */
  private recordFailedAuthAttempt(ip: string): void {
    const now = Date.now();
    const current = this.authAttempts.get(ip) || { count: 0, lockedUntil: 0, lastAttemptAt: now };
    current.count++;
    current.lastAttemptAt = now;
    if (current.count >= AUTH_MAX_ATTEMPTS) {
      current.lockedUntil = now + AUTH_LOCKOUT_MS;
      current.count = 0;
    }
    this.authAttempts.set(ip, current);
  }

  /**
   * Parse `Authorization: Bearer <key>` into the raw key. Returns `null` when
   * the header is absent or malformed so callers can fall back to cookie
   * auth. An empty Bearer value (`Authorization: Bearer`) returns an empty
   * string — that still routes through the invalid-key path (401 +
   * rate-limit) so clients can't probe without penalty.
   */
  private extractBearerKey(req: IncomingMessage): string | null {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return null;
    const match = header.match(/^Bearer\s+(.*)$/i);
    if (!match) return null;
    return match[1].trim();
  }

  /**
   * Timing-safe comparison between the presented Bearer key and the server's
   * live dashboard key. Hashes both to sha256 before comparing so we don't
   * leak length information — same pattern as auth.ts:40 for cookie auth.
   */
  private validateBearerKey(presented: string): boolean {
    const expected = this.auth.getKey();
    if (!presented || !expected) return false;
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: string, query: URLSearchParams | null): Promise<boolean> {
    try {
      // Lightweight "does my session actually work" probe (issue #548 item 1).
      // Reaching here means the session/Bearer auth in handle() already passed,
      // so a 200 here is proof the cookie was stored and is being sent back.
      // The SPA calls this right after a successful login POST and shows a
      // clear "your browser did not store the session cookie" error on 401,
      // instead of dismissing AuthGate into an infinite-loading state.
      if (url === '/dashboard/api/auth/check' && req.method === 'GET') {
        this.json(res, 200, { ok: true });
        return true;
      }

      if (url === '/dashboard/api/overview' && req.method === 'GET') {
        const data = await overviewHandler(this.projectRoot, this.ctx);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/fleet-trend' && req.method === 'GET') {
        const data = await fleetTrendHandler(this.projectRoot, query ?? undefined);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/agents' && req.method === 'GET') {
        const data = await agentsHandler(this.projectRoot, this.ctx.agentConfigs, this.ctx.connectedAgentIds);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/tasks' && req.method === 'GET') {
        const data = await tasksHandler(this.projectRoot, query ?? undefined);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/active-tasks' && req.method === 'GET') {
        const data = await activeTasksHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/consensus' && req.method === 'GET') {
        const data = await consensusHandler(this.projectRoot, query ?? undefined);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/consensus-flow' && req.method === 'GET') {
        // Trust boundary: consensusId arrives via URL query and is allowlisted
        // (`xxxxxxxx-xxxxxxxx` hex) before the handler touches the filesystem.
        // Reject malformed input with 400 here so the handler never sees it.
        const consensusId = query?.get('consensusId')?.trim() ?? '';
        if (!consensusId) {
          this.json(res, 400, { error: 'consensusId query parameter is required' });
          return true;
        }
        if (!isValidConsensusId(consensusId)) {
          this.json(res, 400, { error: 'invalid consensusId shape (expected xxxxxxxx-xxxxxxxx hex)' });
          return true;
        }
        const data = consensusFlowHandler(this.projectRoot, query ?? undefined);
        if ('error' in data) {
          this.json(res, 404, data);
          return true;
        }
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/consensus-reports' && req.method === 'GET') {
        const page = parseInt(query?.get('page') || '1', 10);
        const pageSize = parseInt(query?.get('pageSize') || '5', 10);
        const data = this.getConsensusReports(page, pageSize);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/open-findings' && req.method === 'GET') {
        const data = await openFindingsHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/findings/archive' && req.method === 'POST') {
        const result = this.archiveFindings();
        this.json(res, 200, result);
        return true;
      }

      {
        const m = url.match(/^\/dashboard\/api\/finding\/([^/]+)\/(.+)$/);
        if (m && req.method === 'GET') {
          try {
            const data = await findingHandler(this.projectRoot, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
            this.json(res, 200, data);
          } catch (e: any) {
            this.json(res, 404, { error: e.message });
          }
          return true;
        }
      }

      if (url === '/dashboard/api/signals' && req.method === 'GET') {
        const data = await signalsHandler(this.projectRoot, query ?? undefined);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/signal-activity' && req.method === 'GET') {
        const data = await signalActivityHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/learnings' && req.method === 'GET') {
        const data = await learningsHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/skills' && req.method === 'GET') {
        const data = await skillsGetHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/skills/bind' && req.method === 'POST') {
        let body: unknown;
        try { body = JSON.parse(await readBody(req)); }
        catch { this.json(res, 400, { error: 'Invalid JSON body' }); return true; }
        const data = await skillsBindHandler(this.projectRoot, body as any);
        this.json(res, data.success ? 200 : 400, data);
        return true;
      }

      if (url === '/dashboard/api/logs' && req.method === 'GET') {
        const data = logsHandler(this.projectRoot, query ?? undefined);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/violations' && req.method === 'GET') {
        const data = violationsHandler(this.projectRoot, query ?? undefined);
        this.json(res, 200, data);
        return true;
      }

      // Native memory: /dashboard/api/native-memory (Claude Code auto-memory, flat).
      // Legacy alias `/dashboard/api/auto-memory` is kept for one release — the
      // dashboard now calls the canonical path; remove the alias after the next
      // dashboard bundle ships to all users.
      if (
        (url === '/dashboard/api/native-memory' || url === '/dashboard/api/auto-memory')
        && req.method === 'GET'
      ) {
        const data = await autoMemoryHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      // Gossip memory: /dashboard/api/gossip-memory — gossipcat-owned `.gossip/memory/`
      // store with 4-folder taxonomy. Parallel to native-memory but a different
      // store; dashboard must render them as two separate sections (spec invariant).
      if (url === '/dashboard/api/gossip-memory' && req.method === 'GET') {
        const data = await gossipMemoryHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      // Memory: /dashboard/api/memory/:agentId
      const memoryMatch = url.match(/^\/dashboard\/api\/memory\/([^/]+)$/);
      if (memoryMatch && req.method === 'GET') {
        try {
          const data = await memoryHandler(this.projectRoot, memoryMatch[1]);
          this.json(res, 200, data);
        } catch (err) {
          this.json(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
        }
        return true;
      }

      // SSE event stream — /dashboard/api/events?last_id=N
      // Auth already verified above (cookie or Bearer). Long-lived connection:
      // handleEventsSSE takes over the response and must NOT go through json().
      if (url === '/dashboard/api/events' && req.method === 'GET') {
        handleEventsSSE(req, res);
        return true;
      }

      // Chatbot turn — /dashboard/api/chat. Auth already verified above.
      // Streams SSE (handleChat takes over the response — do NOT go through
      // json()). Read the body with a per-route cap (NOT the shared
      // MAX_BODY_SIZE), then a per-IP min-interval throttle, then hand off.
      if (url === '/dashboard/api/chat' && req.method === 'POST') {
        const ip = req.socket?.remoteAddress || 'unknown';
        if (!this.allowChatTurn(ip)) {
          this.json(res, 429, { error: 'Too many chat requests. Slow down.' });
          return true;
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, CHAT_MAX_BODY));
        } catch {
          this.json(res, 400, { error: 'Invalid JSON body' });
          return true;
        }
        await handleChat(req, res, body, { chatbot: this.chatbot, store: this.chatStore });
        return true;
      }

      this.json(res, 404, { error: 'Unknown API endpoint' });
    } catch (err) {
      this.json(res, 500, { error: 'Internal server error' });
    }
    return true;
  }

  private serveDashboard(res: ServerResponse): boolean {
    if (!this.dashboardRoot) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Dashboard assets not found. Reinstall gossipcat or rebuild from source.');
      return true;
    }
    const htmlPath = join(this.dashboardRoot, 'index.html');
    if (!existsSync(htmlPath)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end(`Dashboard index.html missing at ${this.dashboardRoot}. Reinstall gossipcat.`);
      return true;
    }
    const html = readFileSync(htmlPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  private serveStaticFile(res: ServerResponse, url: string): boolean {
    if (!this.dashboardRoot) return false;
    // Strip /dashboard/ prefix to get the relative path within dist-dashboard/
    const relativePath = url.replace(/^\/dashboard\//, '');
    // Prevent path traversal
    if (relativePath.includes('..')) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const MIME: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
      '.css': 'text/css', '.js': 'application/javascript', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2',
    };
    const ext = '.' + (relativePath.split('.').pop() || '');
    const mime = MIME[ext];
    if (!mime) return false; // Not a static file — fall through to SPA
    const filePath = join(this.dashboardRoot, relativePath);
    try {
      const realFile = realpathSync(filePath);
      const realBase = realpathSync(this.dashboardRoot);
      if (!realFile.startsWith(realBase + '/')) {
        res.writeHead(404);
        res.end();
        return true;
      }
      const data = readFileSync(realFile);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
      return true;
    } catch {
      return false; // File not found — fall through to SPA
    }
  }

  private extractSessionToken(req: IncomingMessage): string | null {
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    const match = cookie.match(/dashboard_session=([^;]+)/);
    return match ? match[1] : null;
  }

  private getConsensusReports(page = 1, pageSize = 5): { reports: any[]; totalReports: number; page: number; pageSize: number; retractedConsensusIds: string[]; roundRetractions: Array<{ consensus_id: string; reason: string; retracted_at: string }> } {
    const { readdirSync, readFileSync, existsSync } = require('fs');
    const reportsDir = join(this.projectRoot, '.gossip', 'consensus-reports');
    // Load retraction tombstones once so the dashboard can render banners + strike-through.
    let retractedConsensusIds: string[] = [];
    let roundRetractions: Array<{ consensus_id: string; reason: string; retracted_at: string }> = [];
    try {
      const { PerformanceReader } = require('@gossip/orchestrator');
      const reader = new PerformanceReader(this.projectRoot);
      retractedConsensusIds = Array.from(reader.getRetractedConsensusIds()) as string[];
      roundRetractions = reader.getRoundRetractions();
    } catch { /* reader unavailable — leave empty */ }
    if (!existsSync(reportsDir)) return { reports: [], totalReports: 0, page, pageSize, retractedConsensusIds, roundRetractions };

    try {
      const { statSync } = require('fs');
      const allFiles = readdirSync(reportsDir)
        .filter((f: string) => f.endsWith('.json'))
        .sort((a: string, b: string) => {
          // Sort by modification time (newest first), not filename
          try {
            const aTime = statSync(join(reportsDir, a)).mtimeMs;
            const bTime = statSync(join(reportsDir, b)).mtimeMs;
            return bTime - aTime;
          } catch { return 0; }
        });

      const totalReports = allFiles.length;
      const clampedPageSize = Math.min(Math.max(pageSize, 1), 20);
      const clampedPage = Math.max(page, 1);
      const start = (clampedPage - 1) * clampedPageSize;
      const files = allFiles.slice(start, start + clampedPageSize);

      const realReportsDir = realpathSync(reportsDir);
      const reports = files.map((f: string) => {
        try {
          const filePath = join(reportsDir, f);
          const realFile = realpathSync(filePath);
          if (!realFile.startsWith(realReportsDir + '/')) return null;
          return normalizeLegacyDegradedFields(JSON.parse(readFileSync(realFile, 'utf-8')));
        } catch { return null; }
      }).filter(Boolean);

      return { reports, totalReports, page: clampedPage, pageSize: clampedPageSize, retractedConsensusIds, roundRetractions };
    } catch { return { reports: [], totalReports: 0, page, pageSize, retractedConsensusIds, roundRetractions }; }
  }

  private archiveFindings(): { archived: number; remaining: number; findingsCleared: number } {
    const { readdirSync, readFileSync, renameSync, writeFileSync, mkdirSync, existsSync } = require('fs');

    // Archive old consensus reports (keep last 5, move rest to archive/)
    const reportsDir = join(this.projectRoot, '.gossip', 'consensus-reports');
    const archiveDir = join(this.projectRoot, '.gossip', 'consensus-reports-archive');
    let archived = 0;

    if (existsSync(reportsDir)) {
      const files = readdirSync(reportsDir)
        .filter((f: string) => f.endsWith('.json'))
        .sort()
        .reverse();

      if (files.length > 5) {
        mkdirSync(archiveDir, { recursive: true });
        const toArchive = files.slice(5);
        for (const f of toArchive) {
          try {
            renameSync(join(reportsDir, f), join(archiveDir, f));
            archived++;
          } catch { /* skip */ }
        }
      }
    }

    // Clear resolved findings from implementation-findings.jsonl
    const findingsPath = join(this.projectRoot, '.gossip', 'implementation-findings.jsonl');
    let findingsCleared = 0;
    if (existsSync(findingsPath)) {
      try {
        const lines = readFileSync(findingsPath, 'utf-8').trim().split('\n').filter(Boolean);
        const kept = lines.filter((line: string) => {
          try {
            const entry = JSON.parse(line);
            if (entry.status === 'resolved' || entry.tag === 'confirmed') {
              findingsCleared++;
              return false;
            }
            return true;
          } catch { return true; }
        });
        writeFileSync(findingsPath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
      } catch { /* skip */ }
    }

    const remaining = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((f: string) => f.endsWith('.json')).length
      : 0;

    return { archived, remaining, findingsCleared };
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

const MAX_BODY_SIZE = 8 * 1024; // 8 KB — ample for auth key and skill bind payloads

function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', (err) => { if (!tooLarge) reject(err); });
  });
}
