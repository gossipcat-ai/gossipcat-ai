"use strict";
/**
 * GossipAgent — WebSocket client for the Gossip Mesh relay.
 *
 * Auth: initial JSON frame (NOT URL query params — security).
 * Messages: MessagePack-encoded MessageEnvelope via Codec.
 * Reconnect: exponential backoff with configurable limits.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GossipAgent = void 0;
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
const types_1 = require("@gossip/types");
const msgpack_1 = require("@msgpack/msgpack");
// ─── WebSocket close code labels (RFC 6455) ───────────────────────────────────
const WS_CLOSE_LABELS = {
    1000: 'NORMAL',
    1001: 'GOING_AWAY',
    1002: 'PROTOCOL_ERROR',
    1003: 'UNSUPPORTED_DATA',
    1005: 'NO_STATUS',
    1006: 'ABNORMAL_CLOSE',
    1007: 'INVALID_PAYLOAD',
    1008: 'POLICY_VIOLATION',
    1009: 'MESSAGE_TOO_BIG',
    1010: 'MISSING_EXTENSION',
    1011: 'INTERNAL_ERROR',
    1012: 'SERVICE_RESTART',
    1013: 'TRY_AGAIN_LATER',
    1014: 'BAD_GATEWAY',
    1015: 'TLS_HANDSHAKE_FAIL',
};
// ─── GossipAgent ─────────────────────────────────────────────────────────────
class GossipAgent extends events_1.EventEmitter {
    ws = null;
    codec = new types_1.Codec();
    config;
    seq = 0;
    reconnectAttempts = 0;
    reconnectTimer = null;
    keepAliveTimer = null;
    _connected = false;
    _sessionId = null;
    intentionalDisconnect = false;
    constructor(config) {
        super();
        this.config = {
            agentId: config.agentId,
            relayUrl: config.relayUrl,
            apiKey: config.apiKey ?? '',
            reconnect: config.reconnect ?? true,
            maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
            reconnectBaseDelay: config.reconnectBaseDelay ?? 1000,
            keepAliveInterval: config.keepAliveInterval ?? 30000,
        };
    }
    get agentId() { return this.config.agentId; }
    get sessionId() { return this._sessionId; }
    isConnected() {
        return this._connected && this.ws !== null && this.ws.readyState === ws_1.default.OPEN;
    }
    // ─── Public API ─────────────────────────────────────────────────────────────
    connect() {
        return new Promise((resolve, reject) => {
            const ws = new ws_1.default(this.config.relayUrl);
            const timeout = setTimeout(() => {
                ws.removeAllListeners();
                ws.on('error', () => { });
                ws.close();
                reject(new Error('Connection timeout'));
            }, 10000);
            ws.once('open', () => {
                // Send auth frame
                ws.send(JSON.stringify({ type: 'auth', agentId: this.config.agentId }));
            });
            ws.once('error', (err) => {
                clearTimeout(timeout);
                ws.removeAllListeners();
                reject(err);
            });
            ws.on('message', (data) => {
                // Auth handshake — first message is JSON
                if (!this._connected) {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.type === 'auth_ok') {
                            clearTimeout(timeout);
                            this.ws = ws;
                            this._connected = true;
                            this._sessionId = msg.sessionId;
                            this.reconnectAttempts = 0;
                            // Swap to binary message handler
                            ws.removeAllListeners('message');
                            ws.on('message', (d) => this.handleMessage(d));
                            ws.on('close', (code, reason) => this.handleClose(code, reason));
                            this.startKeepAlive();
                            this.emit('connect', msg.sessionId);
                            resolve();
                        }
                        else if (msg.type === 'error') {
                            clearTimeout(timeout);
                            ws.removeAllListeners();
                            ws.close();
                            reject(new Error(msg.message ?? 'Auth error'));
                        }
                    }
                    catch (e) {
                        clearTimeout(timeout);
                        ws.removeAllListeners();
                        ws.close();
                        reject(e);
                    }
                    return;
                }
                this.handleMessage(data);
            });
        });
    }
    async disconnect() {
        this.stopKeepAlive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (!this.ws)
            return;
        return new Promise((resolve) => {
            this.intentionalDisconnect = true;
            this._connected = false;
            const ws = this.ws;
            this.ws = null;
            let settled = false;
            const done = (code = 1000) => {
                if (settled)
                    return;
                settled = true;
                this.intentionalDisconnect = false;
                this.emit('disconnect', code);
                resolve();
            };
            const timer = setTimeout(() => done(1000), 2000);
            ws.once('close', (code) => { clearTimeout(timer); done(code); });
            ws.removeAllListeners('message');
            ws.close(1000);
        });
    }
    async sendDirect(to, data) {
        const body = Buffer.from((0, msgpack_1.encode)(data));
        const msg = types_1.Message.createDirect(this.config.agentId, to, body, { seq: this.seq++ });
        await this.sendEnvelope(msg.envelope);
    }
    async sendChannel(channel, data) {
        const ch = channel.replace(/^#/, '');
        const body = Buffer.from((0, msgpack_1.encode)(data));
        const msg = types_1.Message.createChannel(this.config.agentId, ch, body, { seq: this.seq++ });
        await this.sendEnvelope(msg.envelope);
    }
    async subscribe(channel) {
        const ch = channel.replace(/^#/, '');
        const msg = types_1.Message.createSubscription(this.config.agentId, ch, undefined, { seq: this.seq++ });
        await this.sendEnvelope(msg.envelope);
    }
    async unsubscribe(channel) {
        const ch = channel.replace(/^#/, '');
        const msg = types_1.Message.createUnsubscription(this.config.agentId, ch, { seq: this.seq++ });
        await this.sendEnvelope(msg.envelope);
    }
    async sendEnvelope(envelope) {
        if (!this.isConnected()) {
            throw new Error('Not connected to relay');
        }
        const encoded = Buffer.from(this.codec.encode(envelope));
        return new Promise((resolve, reject) => {
            this.ws.send(encoded, (err) => err ? reject(err) : resolve());
        });
    }
    // ─── Internal ────────────────────────────────────────────────────────────────
    handleMessage(data) {
        try {
            const buf = data instanceof Buffer ? data : Buffer.from(data);
            const envelope = this.codec.decode(buf);
            let body = null;
            if (envelope.body && envelope.body.length > 0) {
                body = (0, msgpack_1.decode)(envelope.body);
            }
            this.emit('message', body, envelope);
        }
        catch (err) {
            if (this.listenerCount('error') > 0) {
                this.emit('error', err);
            }
            else {
                console.warn('[GossipAgent] Message decode error:', err.message);
            }
        }
    }
    handleClose(code, reason) {
        this.stopKeepAlive();
        this._connected = false;
        this.ws = null;
        const label = WS_CLOSE_LABELS[code] ?? 'UNKNOWN';
        console.log(`[GossipAgent] Closed: ${label} (${code}) ${reason?.toString() || ''}`);
        if (!this.intentionalDisconnect) {
            this.emit('disconnect', code);
            this.attemptReconnect();
        }
    }
    attemptReconnect() {
        if (!this.config.reconnect || this.intentionalDisconnect)
            return;
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.warn(`[GossipAgent] Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
            return;
        }
        const delay = Math.min(this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        console.log(`[GossipAgent] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(async () => {
            if (this.intentionalDisconnect)
                return;
            try {
                await this.connect();
                console.log('[GossipAgent] Reconnected');
            }
            catch (err) {
                console.warn(`[GossipAgent] Reconnect attempt ${this.reconnectAttempts} failed:`, err.message);
                this.attemptReconnect();
            }
        }, delay);
    }
    startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            if (!this.isConnected())
                return;
            const ping = types_1.Message.createPing(this.config.agentId, this.config.agentId, { seq: this.seq++ });
            this.sendEnvelope(ping.envelope).catch(() => { });
        }, this.config.keepAliveInterval);
    }
    stopKeepAlive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }
    toString() { return `GossipAgent(${this.config.agentId})`; }
    toJSON() {
        return { agentId: this.config.agentId, connected: this.isConnected() };
    }
}
exports.GossipAgent = GossipAgent;
//# sourceMappingURL=gossip-agent.js.map