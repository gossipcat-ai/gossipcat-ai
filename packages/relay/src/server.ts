/**
 * Relay Server
 *
 * Clean WebSocket server for routing messages between agents.
 * Auth via initial JSON frame, then MessagePack for all subsequent messages.
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { Codec } from '@gossip/types';
import { ConnectionManager } from './connection-manager';
import { MessageRouter } from './router';
import { AgentConnection } from './agent-connection';

export interface RelayServerConfig {
  port: number;
  host?: string;
  authTimeoutMs?: number;
  apiKey?: string;  // If set, clients must provide this exact key to authenticate
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
      this.wss = new WebSocketServer({
        server: this.httpServer,
        maxPayload: 1 * 1024 * 1024, // S1: 1 MiB — rejects oversized frames before buffering
      });
      this.wss.on('connection', this.handleConnection.bind(this));
      this.httpServer.listen(this.config.port, this.config.host || '0.0.0.0', () => {
        const addr = this.httpServer.address() as { port: number };
        this._port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.router.stop();  // stop presence tracker interval
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

            // Validate API key if server has one configured
            if (expectedKey && authMsg.apiKey !== expectedKey) {
              clearTimeout(authTimer);
              ws.close(1008, 'Invalid API key');
              return;
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
    res.writeHead(404);
    res.end();
  }
}
