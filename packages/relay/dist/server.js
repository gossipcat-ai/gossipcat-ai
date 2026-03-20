"use strict";
/**
 * Relay Server
 *
 * Clean WebSocket server for routing messages between agents.
 * Auth via initial JSON frame, then MessagePack for all subsequent messages.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RelayServer = void 0;
const ws_1 = require("ws");
const http_1 = require("http");
const crypto_1 = require("crypto");
const types_1 = require("@gossip/types");
const connection_manager_1 = require("./connection-manager");
const router_1 = require("./router");
const agent_connection_1 = require("./agent-connection");
class RelayServer {
    config;
    wss;
    httpServer;
    connectionManager;
    router;
    codec = new types_1.Codec();
    _port = 0;
    authTimeoutMs;
    constructor(config) {
        this.config = config;
        this.connectionManager = new connection_manager_1.ConnectionManager();
        this.router = new router_1.MessageRouter(this.connectionManager);
        this.authTimeoutMs = config.authTimeoutMs ?? 5000;
    }
    get port() { return this._port; }
    get url() { return `ws://localhost:${this._port}`; }
    async start() {
        return new Promise((resolve) => {
            this.httpServer = (0, http_1.createServer)(this.handleHttp.bind(this));
            this.wss = new ws_1.WebSocketServer({ server: this.httpServer });
            this.wss.on('connection', this.handleConnection.bind(this));
            this.httpServer.listen(this.config.port, this.config.host || '0.0.0.0', () => {
                const addr = this.httpServer.address();
                this._port = addr.port;
                resolve();
            });
        });
    }
    async stop() {
        for (const client of this.wss.clients) {
            client.close(1001, 'Server shutting down');
        }
        return new Promise((resolve) => {
            this.wss.close(() => {
                this.httpServer.close(() => resolve());
            });
        });
    }
    handleConnection(ws, _req) {
        let authenticated = false;
        let connection = null;
        // Auth timeout — close if not authenticated in time
        const authTimer = setTimeout(() => {
            if (!authenticated) {
                ws.close(1008, 'Authentication timeout');
            }
        }, this.authTimeoutMs);
        ws.on('message', (data) => {
            try {
                if (!authenticated) {
                    const authMsg = JSON.parse(data.toString());
                    if (authMsg.type === 'auth' && authMsg.agentId) {
                        clearTimeout(authTimer);
                        const sessionId = (0, crypto_1.randomUUID)();
                        connection = new agent_connection_1.AgentConnection(sessionId, authMsg.agentId, ws);
                        this.connectionManager.register(sessionId, connection);
                        authenticated = true;
                        ws.send(JSON.stringify({ type: 'auth_ok', sessionId, agentId: authMsg.agentId }));
                        return;
                    }
                    ws.close(1008, 'Authentication required');
                    return;
                }
                // Authenticated — decode MessagePack and route
                const envelope = this.codec.decode(data);
                // Stamp sender ID from authenticated session (prevents impersonation)
                envelope.sid = connection.agentId;
                this.router.route(envelope, connection);
            }
            catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: err.message }));
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
    handleHttp(req, res) {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', connections: this.connectionManager.count }));
            return;
        }
        res.writeHead(404);
        res.end();
    }
}
exports.RelayServer = RelayServer;
//# sourceMappingURL=server.js.map