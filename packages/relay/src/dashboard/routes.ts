import { IncomingMessage, ServerResponse } from 'http';
import { DashboardAuth } from './auth';
import { overviewHandler } from './api-overview';
import { agentsHandler } from './api-agents';
import { skillsGetHandler, skillsBindHandler } from './api-skills';
import { memoryHandler } from './api-memory';
import { consensusHandler } from './api-consensus';
import { signalsHandler } from './api-signals';
import { learningsHandler } from './api-learnings';
import { tasksHandler } from './api-tasks';
import { activeTasksHandler } from './api-active-tasks';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface AgentConfigLike {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  skills: string[];
  native?: boolean;
}

interface DashboardContext {
  agentConfigs: AgentConfigLike[];
  relayConnections: number;
  connectedAgentIds: string[];
}

const AUTH_MAX_ATTEMPTS = 10;
const AUTH_LOCKOUT_MS = 60_000; // 1 minute lockout after max attempts

export class DashboardRouter {
  private authAttempts = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private auth: DashboardAuth,
    private projectRoot: string,
    private ctx: DashboardContext,
  ) {}

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

    // All other /dashboard/api/* routes require session
    if (url.startsWith('/dashboard/api/')) {
      const token = this.extractSessionToken(req);
      if (!token || !this.auth.validateSession(token)) {
        this.json(res, 401, { error: 'Unauthorized' });
        return true;
      }
      return this.handleApi(req, res, url, query);
    }

    // Static assets
    if (url.startsWith('/dashboard/assets/')) {
      return this.serveAsset(res, url);
    }

    // Serve static dashboard (SPA) — catch-all for client-side routing
    if (url === '/dashboard' || url === '/dashboard/' || (url.startsWith('/dashboard') && !url.startsWith('/dashboard/api/') && !url.startsWith('/dashboard/assets/'))) {
      return this.serveDashboard(res);
    }

    this.json(res, 404, { error: 'Not found' });
    return true;
  }

  private async handleAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    // Rate limiting per IP — prune expired entries to prevent memory leak
    const now = Date.now();
    const ip = req.socket?.remoteAddress || 'unknown';
    if (this.authAttempts.size > 100) {
      for (const [k, v] of this.authAttempts) {
        if (v.lockedUntil > 0 && v.lockedUntil < now) this.authAttempts.delete(k);
      }
    }
    const attempt = this.authAttempts.get(ip);
    if (attempt && attempt.lockedUntil > now) {
      this.json(res, 429, { error: 'Too many attempts. Try again later.' });
      return true;
    }

    const body = await readBody(req);
    try {
      const { key } = JSON.parse(body);
      const token = this.auth.createSession(key);
      if (!token) {
        const current = this.authAttempts.get(ip) || { count: 0, lockedUntil: 0 };
        current.count++;
        if (current.count >= AUTH_MAX_ATTEMPTS) {
          current.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
          current.count = 0;
        }
        this.authAttempts.set(ip, current);
        this.json(res, 401, { error: 'Invalid key' });
        return true;
      }
      // Successful auth — clear attempts
      this.authAttempts.delete(ip);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `dashboard_session=${token}; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      this.json(res, 400, { error: 'Invalid request body' });
    }
    return true;
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: string, query: URLSearchParams | null): Promise<boolean> {
    try {
      if (url === '/dashboard/api/overview' && req.method === 'GET') {
        const data = await overviewHandler(this.projectRoot, this.ctx);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/agents' && req.method === 'GET') {
        const data = await agentsHandler(this.projectRoot, this.ctx.agentConfigs, this.ctx.connectedAgentIds);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/tasks' && req.method === 'GET') {
        const data = await tasksHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/active-tasks' && req.method === 'GET') {
        const data = await activeTasksHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/consensus' && req.method === 'GET') {
        const data = await consensusHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/signals' && req.method === 'GET') {
        const agentFilter = query?.get('agent') ?? null;
        const data = await signalsHandler(this.projectRoot, agentFilter);
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

      this.json(res, 404, { error: 'Unknown API endpoint' });
    } catch (err) {
      this.json(res, 500, { error: 'Internal server error' });
    }
    return true;
  }

  private serveDashboard(res: ServerResponse): boolean {
    const htmlPath = join(this.projectRoot, 'dist-dashboard', 'index.html');
    if (!existsSync(htmlPath)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Dashboard not built. Run: npm run build:dashboard');
      return true;
    }
    const html = readFileSync(htmlPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  private serveAsset(res: ServerResponse, _url: string): boolean {
    // No assets in Phase 1 — everything is bundled in index.html
    res.writeHead(404);
    res.end();
    return true;
  }

  private extractSessionToken(req: IncomingMessage): string | null {
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    const match = cookie.match(/dashboard_session=([^;]+)/);
    return match ? match[1] : null;
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

const MAX_BODY_SIZE = 8 * 1024; // 8 KB — ample for auth key and skill bind payloads

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
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
