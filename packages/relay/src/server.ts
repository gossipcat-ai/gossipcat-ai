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
}

export class RelayServer {
  private wss!: WebSocketServer;
  private httpServer!: ReturnType<typeof createServer>;
  private connectionManager: ConnectionManager;
  private router: MessageRouter;
  private codec = new Codec();
  private _port: number = 0;
  private authTimeoutMs: number;

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
      this.wss = new WebSocketServer({ server: this.httpServer });
      this.wss.on('connection', this.handleConnection.bind(this));
      this.httpServer.listen(this.config.port, this.config.host || '0.0.0.0', () => {
        const addr = this.httpServer.address() as { port: number };
        this._port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => resolve());
      });
    });
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    let authenticated = false;
    let connection: AgentConnection | null = null;

    // Auth timeout — close if not authenticated in time
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        ws.close(1008, 'Authentication timeout');
      }
    }, this.authTimeoutMs);

    ws.on('message', (data: RawData) => {
      try {
        if (!authenticated) {
          const authMsg = JSON.parse(data.toString());
          if (authMsg.type === 'auth' && authMsg.agentId) {
            clearTimeout(authTimer);
            const sessionId = randomUUID();
            connection = new AgentConnection(sessionId, authMsg.agentId, ws);
            this.connectionManager.register(sessionId, connection);
            authenticated = true;
            ws.send(JSON.stringify({ type: 'auth_ok', sessionId, agentId: authMsg.agentId }));
            return;
          }
          ws.close(1008, 'Authentication required');
          return;
        }

        // Authenticated — decode MessagePack and route
        const envelope = this.codec.decode(data as Buffer);
        // Stamp sender ID from authenticated session (prevents impersonation)
        envelope.sid = connection!.agentId;
        this.router.route(envelope, connection!);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (connection) {
        this.router.onAgentDisconnect(connection.sessionId);
        this.connectionManager.unregister(connection.sessionId);
      }
    });

    ws.on('error', () => {
      clearTimeout(authTimer);
      if (connection) {
        this.router.onAgentDisconnect(connection.sessionId);
        this.connectionManager.unregister(connection.sessionId);
      }
    });
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
