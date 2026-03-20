"use strict";
/**
 * Agent Connection
 *
 * Represents a single connected agent with its WebSocket reference.
 * Provides send() using Codec to encode outgoing MessageEnvelopes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentConnection = void 0;
const ws_1 = require("ws");
const types_1 = require("@gossip/types");
const codec = new types_1.Codec();
/**
 * AgentConnection wraps a WebSocket for a single authenticated agent session.
 */
class AgentConnection {
    sessionId;
    agentId;
    ws;
    seq = 0;
    active = true;
    constructor(sessionId, agentId, ws) {
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.ws = ws;
        ws.on('close', () => {
            this.active = false;
        });
    }
    /**
     * Send a MessageEnvelope to this agent via MessagePack encoding.
     */
    send(envelope) {
        if (!this.active || this.ws.readyState !== ws_1.WebSocket.OPEN) {
            throw new Error(`Cannot send to ${this.agentId}: connection not open`);
        }
        const data = codec.encode(envelope);
        this.ws.send(data);
        this.seq++;
    }
    /**
     * Get next outgoing sequence number.
     */
    nextSeq() {
        return this.seq;
    }
    /**
     * Check if connection is still active.
     */
    isActive() {
        return this.active && this.ws.readyState === ws_1.WebSocket.OPEN;
    }
}
exports.AgentConnection = AgentConnection;
//# sourceMappingURL=agent-connection.js.map