"use strict";
/**
 * Message Router
 *
 * Routes messages to their destinations based on message type.
 * Handles all 9 MessageType cases with O(1) lookups via ConnectionManager.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageRouter = void 0;
const crypto_1 = require("crypto");
const types_1 = require("@gossip/types");
const channels_1 = require("./channels");
const subscription_manager_1 = require("./subscription-manager");
const presence_1 = require("./presence");
class MessageRouter {
    connectionManager;
    channelManager;
    subscriptionManager;
    presenceTracker;
    metrics = {
        messagesRouted: 0,
        messagesByType: {},
        routingErrors: 0,
        averageLatencyMs: 0
    };
    totalLatency = 0;
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this.channelManager = new channels_1.ChannelManager();
        this.subscriptionManager = new subscription_manager_1.SubscriptionManager();
        this.presenceTracker = new presence_1.PresenceTracker();
    }
    /**
     * Route an envelope to its destination. Sender must be pre-authenticated.
     */
    route(envelope, _sender) {
        const start = performance.now();
        try {
            switch (envelope.t) {
                case types_1.MessageType.DIRECT:
                    this.routeDirect(envelope);
                    break;
                case types_1.MessageType.CHANNEL:
                    this.routeChannel(envelope);
                    break;
                case types_1.MessageType.RPC_REQUEST:
                    this.routeToAgent(envelope);
                    break;
                case types_1.MessageType.RPC_RESPONSE:
                    this.routeToAgent(envelope);
                    break;
                case types_1.MessageType.SUBSCRIPTION:
                    this.handleSubscription(envelope);
                    break;
                case types_1.MessageType.UNSUBSCRIPTION:
                    this.handleUnsubscription(envelope);
                    break;
                case types_1.MessageType.PRESENCE:
                    this.handlePresence(envelope);
                    break;
                case types_1.MessageType.PING:
                    this.handlePing(envelope);
                    break;
                case types_1.MessageType.ERROR:
                    this.routeDirect(envelope);
                    break;
                default:
                    this.sendError(envelope.sid, 'INVALID_TYPE', `Unknown message type: ${envelope.t}`, envelope.id);
            }
            const latencyMs = performance.now() - start;
            this.metrics.messagesRouted++;
            this.metrics.messagesByType[envelope.t] = (this.metrics.messagesByType[envelope.t] || 0) + 1;
            this.totalLatency += latencyMs;
            this.metrics.averageLatencyMs = this.totalLatency / this.metrics.messagesRouted;
        }
        catch (error) {
            this.metrics.routingErrors++;
            try {
                this.sendError(envelope.sid, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'Unknown error', envelope.id);
            }
            catch { /* ignore */ }
        }
    }
    routeDirect(envelope) {
        const receiver = this.connectionManager.getByAgentId(envelope.rid)
            || this.connectionManager.get(envelope.rid);
        if (!receiver || !receiver.isActive()) {
            this.sendError(envelope.sid, 'AGENT_NOT_FOUND', `Agent ${envelope.rid} not connected`, envelope.id);
            return;
        }
        try {
            receiver.send(envelope);
        }
        catch (error) {
            this.sendError(envelope.sid, 'DELIVERY_FAILED', error instanceof Error ? error.message : 'Failed to deliver', envelope.id);
        }
    }
    routeToAgent(envelope) {
        const receiver = this.connectionManager.getByAgentId(envelope.rid)
            || this.connectionManager.get(envelope.rid);
        if (!receiver || !receiver.isActive()) {
            this.sendError(envelope.sid, 'AGENT_NOT_FOUND', `Agent ${envelope.rid} not available`, envelope.id);
            return;
        }
        receiver.send(envelope);
    }
    routeChannel(envelope) {
        const result = this.channelManager.broadcast(envelope.rid, envelope);
        if (result.failedCount > 0) {
            console.warn(`[Router] Channel broadcast to "${envelope.rid}" had ${result.failedCount} failures`);
        }
    }
    handleSubscription(envelope) {
        const connection = this.connectionManager.getByAgentId(envelope.sid);
        if (!connection)
            return;
        this.channelManager.subscribe(envelope.rid, envelope.sid, connection);
        this.subscriptionManager.addSubscription(envelope.sid, envelope.rid);
    }
    handleUnsubscription(envelope) {
        this.channelManager.unsubscribe(envelope.rid, envelope.sid);
        this.subscriptionManager.removeSubscription(envelope.sid, envelope.rid);
    }
    handlePresence(envelope) {
        this.presenceTracker.handlePresenceMessage(envelope);
    }
    handlePing(envelope) {
        this.presenceTracker.updateLastSeen(envelope.sid);
        const requester = this.connectionManager.getByAgentId(envelope.sid)
            || this.connectionManager.get(envelope.sid);
        if (!requester || !requester.isActive())
            return;
        const pong = {
            ...envelope,
            id: (0, crypto_1.randomUUID)(),
            sid: 'relay',
            rid: envelope.sid,
            ts: Date.now(),
            seq: 0
        };
        requester.send(pong);
    }
    sendError(toAgentId, errorCode, description, relatedMessageId) {
        const receiver = this.connectionManager.getByAgentId(toAgentId);
        if (!receiver || !receiver.isActive())
            return;
        const errorMsg = {
            v: 1,
            t: types_1.MessageType.ERROR,
            f: 0,
            id: (0, crypto_1.randomUUID)(),
            sid: 'relay',
            rid: toAgentId,
            rid_req: relatedMessageId,
            ts: Date.now(),
            seq: 0,
            ttl: 0,
            meta: { error_code: errorCode, description },
            body: new Uint8Array(0)
        };
        try {
            receiver.send(errorMsg);
        }
        catch { /* ignore */ }
    }
    /**
     * Clean up all resources for a disconnecting agent.
     */
    onAgentDisconnect(sessionId) {
        const connection = this.connectionManager.get(sessionId);
        if (!connection)
            return;
        const agentId = connection.agentId;
        const channels = this.subscriptionManager.removeAllSubscriptions(agentId);
        for (const channelName of channels) {
            this.channelManager.unsubscribe(channelName, agentId);
        }
        this.presenceTracker.removePresence(agentId);
    }
    getMetrics() {
        return { ...this.metrics };
    }
    getChannelManager() {
        return this.channelManager;
    }
    getPresenceTracker() {
        return this.presenceTracker;
    }
}
exports.MessageRouter = MessageRouter;
//# sourceMappingURL=router.js.map