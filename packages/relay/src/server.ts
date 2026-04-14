/**
 * Relay Server
 *
 * Clean WebSocket server for routing messages between agents.
 * Auth via initial JSON frame, then MessagePack for all subsequent messages.
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID, timingSafeEqual } from 'crypto';
import { Codec } from '@gossip/types';
import { ConnectionManager } from './connection-manager';
import { MessageRouter } from './router';
import { AgentConnection } from './agent-connection';
import { DashboardAuth } from './dashboard/auth';
import { DashboardRouter } from './dashboard/routes';
import { DashboardWs } from './dashboard/ws';

export interface DashboardConfig {
  projectRoot: string;
  agentConfigs: Array<{ id: string; provider: string; model: string; preset?: string; skills: string[]; native?: boolean }>;
}

export interface RelayServerConfig {
  port: number;
  host?: string;
  authTimeoutMs?: number;
  apiKey?: string;  // If set, clients must provide this exact key to authenticate
  dashboard?: DashboardConfig;  // If set, enables the dashboard UI
}

export class RelayServer {
  private wss!: WebSocketServer;
  private httpServer!: ReturnType<typeof createServer>;
  private connectionManager: ConnectionManager;
  private router: MessageRouter;
  private codec = new Codec();
  private _port: number = 0;
  private authTimeoutMs: number;
  private connectionsByIp = new Map<string, number>();
  private readonly maxConnectionsPerIp = 10;
  private readonly maxTotalConnections = 500;
  private dashboardAuth: DashboardAuth | null = null;
  private dashboardRouter: DashboardRouter | null = null;
  private dashboardWs: DashboardWs | null = null;
  private dashboardUpgrader: WebSocketServer | null = null; // single instance — avoids per-request leak

  constructor(private config: RelayServerConfig) {
    this.connectionManager = new ConnectionManager();
    this.router = new MessageRouter(this.connectionManager);
    this.authTimeoutMs = config.authTimeoutMs ?? 5000;
  }

  get port(): number { return this._port; }
  get url(): string { return `ws://localhost:${this._port}`; }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = createServer(this.handleHttp.bind(this));

      if (this.config.dashboard) {
        this.dashboardAuth = new DashboardAuth();
        this.dashboardAuth.init();
        this.dashboardWs = new DashboardWs();
        this.dashboardWs.startLogWatcher(this.config.dashboard.projectRoot);
        this.dashboardUpgrader = new WebSocketServer({ noServer: true });
        this.dashboardRouter = new DashboardRouter(
          this.dashboardAuth,
          this.config.dashboard.projectRoot,
          {
            agentConfigs: this.config.dashboard.agentConfigs,
            relayConnections: this.connectionManager.count,
            connectedAgentIds: this.connectionManager.getAll().map(c => c.agentId),
          },
        );
      }

      this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });
      this.wss.on('connection', this.handleConnection.bind(this));

      this.httpServer.on('upgrade', (req, socket, head) => {
        const url = req.url ?? '';
        if (url === '/dashboard/ws' && this.dashboardWs && this.dashboardUpgrader) {
          // Dashboard WebSocket — validate session cookie before accepting
          const cookie = req.headers.cookie ?? '';
          const match = cookie.match(/dashboard_session=([^;]+)/);
          const token = match ? match[1] : null;
          if (!token || !this.dashboardAuth?.validateSession(token)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          this.dashboardUpgrader.handleUpgrade(req, socket, head, (ws) => {
            this.dashboardWs!.addClient(ws);
            ws.on('close', () => this.dashboardWs!.removeClient(ws));
            ws.on('error', () => this.dashboardWs!.removeClient(ws));
          });
        } else {
          // Agent WebSocket — existing logic
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
          });
        }
      });

      this.httpServer.listen(this.config.port, this.config.host ?? '127.0.0.1', () => {
        const addr = this.httpServer.address() as { port: number };
        this._port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.router.stop();  // stop presence tracker interval
    // Close dashboard clients and upgrader
    if (this.dashboardWs) {
      this.dashboardWs.stopLogWatcher();
      for (const client of this.dashboardWs.getClients()) {
        client.close(1001, 'Server shutting down');
      }
    }
    if (this.dashboardUpgrader) {
      this.dashboardUpgrader.close();
    }
    this.connectionsByIp.clear();
    // Close agent clients
    for (const client of this.wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => resolve());
      });
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // S2: Connection rate limiting — reject if too many from same IP or at capacity
    const ip = req.socket.remoteAddress ?? 'unknown';

    if (this.wss.clients.size > this.maxTotalConnections) {
      ws.close(1013, 'Server at capacity');
      return;
    }

    const ipCount = (this.connectionsByIp.get(ip) ?? 0) + 1;
    if (ipCount > this.maxConnectionsPerIp) {
      ws.close(1013, 'Too many connections from your IP');
      return;
    }
    this.connectionsByIp.set(ip, ipCount);

    let authenticated = false;
    let connection: AgentConnection | null = null;
    let authAttempts = 0;
    let cleaned = false; // Idempotent cleanup flag — prevents double-decrement
    const maxAuthAttempts = 3;
    const expectedKey = this.config.apiKey;

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        ws.close(1008, 'Authentication timeout');
      }
    }, this.authTimeoutMs);

    // Idempotent cleanup — safe to call from both close and error
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      decrementIp();
      clearTimeout(authTimer);
      if (connection) {
        this.router.onAgentDisconnect(connection.sessionId);
        this.connectionManager.unregister(connection.sessionId);
        this.updateDashboardConnectionCount();
      }
    };

    ws.on('message', (data: RawData) => {
      try {
        if (!authenticated) {
          authAttempts++;
          if (authAttempts > maxAuthAttempts) {
            clearTimeout(authTimer);
            ws.close(1008, 'Too many auth attempts');
            return;
          }

          const authMsg = JSON.parse(data.toString());
          if (authMsg.type === 'auth' && authMsg.agentId) {
            if (!authMsg.apiKey) {
              clearTimeout(authTimer);
              ws.close(1008, 'API key required');
              return;
            }

            // Validate API key — timing-safe comparison to prevent enumeration
            if (expectedKey) {
              const a = Buffer.from(String(authMsg.apiKey));
              const b = Buffer.from(expectedKey);
              if (a.length !== b.length || !timingSafeEqual(a, b)) {
                clearTimeout(authTimer);
                ws.close(1008, 'Invalid API key');
                return;
              }
            }

            // Validate agentId format — alphanumeric, hyphens, underscores, max 64 chars
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(authMsg.agentId)) {
              clearTimeout(authTimer);
              ws.close(1008, 'Invalid agent ID format');
              return;
            }

            clearTimeout(authTimer);
            const sessionId = randomUUID();

            // Handle reconnect collision gracefully
            try {
              connection = new AgentConnection(sessionId, authMsg.agentId, ws);
              this.connectionManager.register(sessionId, connection);
            } catch (regErr) {
              ws.close(1008, 'Agent ID already connected');
              return;
            }

            authenticated = true;
            this.updateDashboardConnectionCount();
            ws.send(JSON.stringify({ type: 'auth_ok', sessionId, agentId: authMsg.agentId }));
            return;
          }
          clearTimeout(authTimer);
          ws.close(1008, 'Authentication required');
          return;
        }

        // Authenticated — normalize RawData, decode MessagePack, and route
        const buf = Array.isArray(data) ? Buffer.concat(data) : (data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer));
        const envelope = this.codec.decode(buf);
        envelope.sid = connection!.agentId;
        this.router.route(envelope, connection!);
      } catch (err) {
        if (authenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        } else {
          clearTimeout(authTimer);
          ws.close(1008, 'Bad request');
        }
      }
    });

    const decrementIp = () => {
      const current = this.connectionsByIp.get(ip) ?? 1;
      if (current <= 1) {
        this.connectionsByIp.delete(ip);
      } else {
        this.connectionsByIp.set(ip, current - 1);
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', connections: this.connectionManager.count }));
      return;
    }

    if (req.url?.startsWith('/dashboard') && this.dashboardRouter) {
      this.dashboardRouter.handle(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  get dashboardKey(): string {
    return this.dashboardAuth?.getKey() ?? '';
  }

  get dashboardKeyPrefix(): string {
    return this.dashboardAuth?.getKeyPrefix() ?? '';
  }

  get dashboardUrl(): string {
    if (!this.dashboardAuth) return '';
    return `http://localhost:${this._port}/dashboard`;
  }

  /** Call from handleConnection cleanup to keep relay count current */
  private updateDashboardConnectionCount(): void {
    this.dashboardRouter?.updateContext({
      relayConnections: this.connectionManager.count,
      connectedAgentIds: this.connectionManager.getAll().map(c => c.agentId),
    });
  }

  /**
   * Update the dashboard's cached agent configs. Call from the MCP server
   * after gossip_setup writes config.json so the Team page reflects the new
   * team without requiring /mcp reconnect. The boot-time snapshot
   * (mcp-server-sdk.ts:365) still wins on initial boot — this method is a
   * post-setup override, not a replacement.
   */
  setAgentConfigs(configs: Array<{ id: string; provider: string; model: string; preset?: string; skills: string[]; native?: boolean }>): void {
    this.dashboardRouter?.updateContext({ agentConfigs: configs });
  }
}
