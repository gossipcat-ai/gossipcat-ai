import { IncomingMessage, ServerResponse } from 'http';
import { DashboardAuth } from './auth';
import { overviewHandler } from './api-overview';
import { agentsHandler } from './api-agents';
import { skillsGetHandler, skillsBindHandler } from './api-skills';
import { memoryHandler } from './api-memory';
import { autoMemoryHandler } from './api-auto-memory';
import { consensusHandler } from './api-consensus';
import { signalsHandler } from './api-signals';
import { learningsHandler } from './api-learnings';
import { tasksHandler } from './api-tasks';
import { activeTasksHandler } from './api-active-tasks';
import { logsHandler } from './api-logs';
import { readFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';

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
  private authAttempts = new Map<string, { count: number; lockedUntil: number }>();
  private dashboardRoot: string | null;

  constructor(
    private auth: DashboardAuth,
    private projectRoot: string,
    private ctx: DashboardContext,
  ) {
    this.dashboardRoot = resolveDashboardRoot(projectRoot);
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

    // All other /dashboard/api/* routes require session
    if (url.startsWith('/dashboard/api/')) {
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
        'Set-Cookie': `dashboard_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/dashboard; Max-Age=86400`,
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

      if (url === '/dashboard/api/consensus-reports' && req.method === 'GET') {
        const page = parseInt(query?.get('page') || '1', 10);
        const pageSize = parseInt(query?.get('pageSize') || '5', 10);
        const data = this.getConsensusReports(page, pageSize);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/findings/archive' && req.method === 'POST') {
        const result = this.archiveFindings();
        this.json(res, 200, result);
        return true;
      }

      if (url === '/dashboard/api/signals' && req.method === 'GET') {
        const data = await signalsHandler(this.projectRoot, query ?? undefined);
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

      // Auto-memory: /dashboard/api/auto-memory (Claude Code project memory)
      if (url === '/dashboard/api/auto-memory' && req.method === 'GET') {
        const data = await autoMemoryHandler(this.projectRoot);
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

  private getConsensusReports(page = 1, pageSize = 5): { reports: any[]; totalReports: number; page: number; pageSize: number } {
    const { readdirSync, readFileSync, existsSync } = require('fs');
    const reportsDir = join(this.projectRoot, '.gossip', 'consensus-reports');
    if (!existsSync(reportsDir)) return { reports: [], totalReports: 0, page, pageSize };

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
          return JSON.parse(readFileSync(realFile, 'utf-8'));
        } catch { return null; }
      }).filter(Boolean);

      return { reports, totalReports, page: clampedPage, pageSize: clampedPageSize };
    } catch { return { reports: [], totalReports: 0, page, pageSize }; }
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
