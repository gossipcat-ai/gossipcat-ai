/**
 * Message Router
 *
 * Routes messages to their destinations based on message type.
 * Handles all 9 MessageType cases with O(1) lookups via ConnectionManager.
 */
import { MessageEnvelope } from '@gossip/types';
import { ConnectionManager } from './connection-manager';
import { AgentConnection } from './agent-connection';
import { ChannelManager } from './channels';
import { PresenceTracker } from './presence';
export interface RouterMetrics {
    messagesRouted: number;
    messagesByType: Record<number, number>;
    routingErrors: number;
    averageLatencyMs: number;
}
export declare class MessageRouter {
    private connectionManager;
    private channelManager;
    private subscriptionManager;
    private presenceTracker;
    private metrics;
    private totalLatency;
    constructor(connectionManager: ConnectionManager);
    /**
     * Route an envelope to its destination. Sender must be pre-authenticated.
     */
    route(envelope: MessageEnvelope, _sender?: AgentConnection): void;
    private routeDirect;
    private routeToAgent;
    private routeChannel;
    private handleSubscription;
    private handleUnsubscription;
    private handlePresence;
    private handlePing;
    private sendError;
    /**
     * Clean up all resources for a disconnecting agent.
     */
    onAgentDisconnect(sessionId: string): void;
    getMetrics(): RouterMetrics;
    getChannelManager(): ChannelManager;
    getPresenceTracker(): PresenceTracker;
}
