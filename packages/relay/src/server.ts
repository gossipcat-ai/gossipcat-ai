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
import { AgentConnection, livenessMap } from './agent-connection';
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
  /**
   * Heartbeat interval in milliseconds. Every tick, the server pings each
   * client; clients that haven't responded to the previous ping are
   * terminated. Default: 30_000 (30 s). Set to 0 to disable heartbeats
   * (mostly useful for tests).
   */
  heartbeatIntervalMs?: number;
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
  // Per-client heartbeat timers. A single global setInterval iterating
  // wss.clients caused a thundering herd: every `heartbeatIntervalMs` all
  // sockets got pinged at once, and a slow event-loop tick could delay every
  // client's pong simultaneously, producing false-positive termination
  // bursts. Per-client intervals with jittered first-tick delays spread the
  // load and decouple liveness checks across connections.
  private clientHeartbeats = new Map<WebSocket, ReturnType<typeof setInterval>>();
  private heartbeatRunning: boolean = false;
  private readonly heartbeatIntervalMs: number;

  constructor(private config: RelayServerConfig) {
    this.connectionManager = new ConnectionManager();
    this.router = new MessageRouter(this.connectionManager);
    this.authTimeoutMs = config.authTimeoutMs ?? 5000;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
  }

  get port(): number { return this._port; }
  get url(): string { return `ws://localhost:${this._port}`; }
  /**
   * True while heartbeat scheduling is active (start was called with a
   * positive interval and stop has not been called). Per-client timers are
   * registered lazily on connection, so this flag — not a single
   * global-interval handle — is the source of truth for "heartbeat on".
   */
  get isHeartbeatRunning(): boolean { return this.heartbeatRunning; }

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

      this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024, clientTracking: true });
      this.wss.on('connection', this.handleConnection.bind(this));
      this.startHeartbeat();

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
    this.stopHeartbeat();
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

  /**
   * Arm heartbeat scheduling.
   *
   * Per-client model: a separate setInterval is registered for each
   * authenticated client (see `scheduleClientHeartbeat`) with a jittered
   * first-tick delay to spread pings across the interval window. Each tick
   * for a given client:
   *   - if `pendingPong === true` from the previous tick, the peer missed a
   *     round-trip → terminate so the router unregisters.
   *   - otherwise mark `pendingPong = true` and send a ws-level ping. The
   *     `pong` handler in agent-connection.ts clears the flag on live reply.
   *
   * This detects half-open TCP connections (NAT silently dropping state,
   * Wi-Fi roam, VM suspend) faster than the default ~2 min TCP keepalive.
   * Non-agent sockets (dashboard WS) run on `dashboardUpgrader` and are
   * unaffected. Rollback = flip `heartbeatRunning` to false and never call
   * `scheduleClientHeartbeat`.
   */
  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) return; // disabled (mostly for tests)
    this.heartbeatRunning = true;
  }

  private stopHeartbeat(): void {
    this.heartbeatRunning = false;
    for (const [ws, timer] of this.clientHeartbeats) {
      clearInterval(timer);
      this.clientHeartbeats.delete(ws);
    }
  }

  /**
   * Register a per-client heartbeat timer with jittered first-tick delay.
   *
   * Jitter (random 0..heartbeatIntervalMs) breaks up the thundering herd
   * from a single global interval: with ~N simultaneous connections, all
   * pings would otherwise land in the same event-loop tick. Each client
   * instead gets its own offset into the cycle.
   *
   * The timer is cleared in two places: `handleConnection`'s `cleanup`
   * (on ws close/error) and `stopHeartbeat` (on server.stop).
   */
  private scheduleClientHeartbeat(ws: WebSocket): void {
    if (!this.heartbeatRunning) return;
    if (this.heartbeatIntervalMs <= 0) return;
    if (this.clientHeartbeats.has(ws)) return;
    const tick = () => {
      // If the server stopped or the socket already closed, nothing to do.
      if (!this.heartbeatRunning) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      const state = livenessMap.get(ws);
      if (state && state.pendingPong) {
        // Peer never answered the previous ping — treat as dead.
        try {
          ws.terminate();
        } catch {
          // Socket already dead; fall through to local cleanup.
        }
        livenessMap.delete(ws);
        const t = this.clientHeartbeats.get(ws);
        if (t) {
          clearInterval(t);
          this.clientHeartbeats.delete(ws);
        }
        return;
      }
      if (!state) {
        livenessMap.set(ws, { pendingPong: true });
      } else {
        state.pendingPong = true;
      }
      try {
        ws.ping();
      } catch {
        // Socket died between our readyState check and ping(). The prior
        // implementation left a stale liveness entry here and claimed "next
        // tick will clean it up" — but with per-client timers, if the ws
        // closes its events may already have fired and no further tick will
        // run. Clean up explicitly so the claim holds unconditionally.
        livenessMap.delete(ws);
        const t = this.clientHeartbeats.get(ws);
        if (t) {
          clearInterval(t);
          this.clientHeartbeats.delete(ws);
        }
      }
    };
    // Jittered first delay in [0, heartbeatIntervalMs) so connections
    // registered in the same instant don't all fire together.
    const jitter = Math.floor(Math.random() * this.heartbeatIntervalMs);
    const firstTick = setTimeout(() => {
      if (!this.heartbeatRunning) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      tick();
      if (!this.heartbeatRunning) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      const interval = setInterval(tick, this.heartbeatIntervalMs);
      interval.unref?.();
      this.clientHeartbeats.set(ws, interval);
    }, jitter);
    firstTick.unref?.();
    // Store the first-tick timer in the map so stopHeartbeat can cancel it
    // even before the interval phase takes over. setTimeout and setInterval
    // handles are interchangeable under clearInterval/clearTimeout in Node.
    this.clientHeartbeats.set(ws, firstTick as unknown as ReturnType<typeof setInterval>);
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
      // Clear this client's per-client heartbeat timer so it doesn't fire
      // against a closed socket.
      const hbTimer = this.clientHeartbeats.get(ws);
      if (hbTimer) {
        clearInterval(hbTimer);
        this.clientHeartbeats.delete(ws);
      }
      livenessMap.delete(ws);
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
            // Arm per-client heartbeat now that the agent is authenticated.
            // Pre-auth sockets don't need liveness checks — the auth timer
            // already bounds how long they can sit idle.
            this.scheduleClientHeartbeat(ws);
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
