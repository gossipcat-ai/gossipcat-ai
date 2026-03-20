/**
 * GossipAgent — WebSocket client for the Gossip Mesh relay.
 *
 * Auth: initial JSON frame (NOT URL query params — security).
 * Messages: MessagePack-encoded MessageEnvelope via Codec.
 * Reconnect: exponential backoff with configurable limits.
 */
import { EventEmitter } from 'events';
import { MessageEnvelope } from '@gossip/types';
export interface GossipAgentConfig {
    agentId: string;
    relayUrl: string;
    apiKey?: string;
    reconnect?: boolean;
    maxReconnectAttempts?: number;
    reconnectBaseDelay?: number;
    keepAliveInterval?: number;
}
export declare class GossipAgent extends EventEmitter {
    private ws;
    private codec;
    private config;
    private seq;
    private reconnectAttempts;
    private reconnectTimer;
    private keepAliveTimer;
    private _connected;
    private _sessionId;
    private intentionalDisconnect;
    constructor(config: GossipAgentConfig);
    get agentId(): string;
    get sessionId(): string | null;
    isConnected(): boolean;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    sendDirect(to: string, data: Record<string, unknown>): Promise<void>;
    sendChannel(channel: string, data: Record<string, unknown>): Promise<void>;
    subscribe(channel: string): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    sendEnvelope(envelope: MessageEnvelope): Promise<void>;
    private handleMessage;
    private handleClose;
    private attemptReconnect;
    private startKeepAlive;
    private stopKeepAlive;
    toString(): string;
    toJSON(): Record<string, unknown>;
}
