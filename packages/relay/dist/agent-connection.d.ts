/**
 * Agent Connection
 *
 * Represents a single connected agent with its WebSocket reference.
 * Provides send() using Codec to encode outgoing MessageEnvelopes.
 */
import { WebSocket } from 'ws';
import { MessageEnvelope } from '@gossip/types';
/**
 * AgentConnection wraps a WebSocket for a single authenticated agent session.
 */
export declare class AgentConnection {
    readonly sessionId: string;
    readonly agentId: string;
    private ws;
    private seq;
    private active;
    constructor(sessionId: string, agentId: string, ws: WebSocket);
    /**
     * Send a MessageEnvelope to this agent via MessagePack encoding.
     */
    send(envelope: MessageEnvelope): void;
    /**
     * Get next outgoing sequence number.
     */
    nextSeq(): number;
    /**
     * Check if connection is still active.
     */
    isActive(): boolean;
}
