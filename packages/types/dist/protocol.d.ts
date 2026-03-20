/**
 * @gossip/types - Protocol constants and wire format types
 *
 * Shared TypeScript type definitions for Gossip Mesh protocol.
 * Used by relay, client, and orchestrator packages.
 */
/**
 * Message type discriminators (1-9)
 */
export declare enum MessageType {
    DIRECT = 1,// Point-to-point messaging
    CHANNEL = 2,// Pub-sub broadcast
    RPC_REQUEST = 3,// Request-reply pattern
    RPC_RESPONSE = 4,// Response to RPC
    SUBSCRIPTION = 5,// Subscribe to channel
    UNSUBSCRIPTION = 6,// Unsubscribe from channel
    PRESENCE = 7,// Agent status/heartbeat
    PING = 8,// Keep-alive
    ERROR = 9
}
/**
 * Short field names for wire format (minimize overhead)
 */
export declare const FieldNames: {
    readonly version: "v";
    readonly messageType: "t";
    readonly flags: "f";
    readonly messageId: "id";
    readonly senderId: "sid";
    readonly receiverId: "rid";
    readonly requestId: "rid_req";
    readonly timestamp: "ts";
    readonly sequence: "seq";
    readonly ttl: "ttl";
    readonly metadata: "meta";
    readonly body: "body";
};
/**
 * MessageEnvelope structure (11 core fields)
 * This is the wire format that gets encoded with MessagePack
 */
export interface MessageEnvelope {
    v: number;
    t: MessageType;
    f: number;
    id: string;
    sid: string;
    rid: string;
    rid_req?: string;
    ts: number;
    seq: number;
    ttl: number;
    meta?: Record<string, any>;
    body: Uint8Array;
}
/**
 * Transport types
 */
export type TransportType = 'websocket' | 'http' | 'auto';
export declare enum TransportState {
    DISCONNECTED = "disconnected",
    CONNECTING = "connecting",
    CONNECTED = "connected",
    RECONNECTING = "reconnecting",
    CLOSED = "closed"
}
/**
 * Connection states
 */
export declare enum ConnectionState {
    DISCONNECTED = "disconnected",
    CONNECTING = "connecting",
    CONNECTED = "connected",
    RECONNECTING = "reconnecting",
    ERROR = "error"
}
/**
 * Presence status
 */
export declare enum PresenceStatus {
    ONLINE = "online",
    OFFLINE = "offline",
    AWAY = "away",
    BUSY = "busy"
}
/**
 * Client configuration
 */
export interface ClientConfig {
    agentId: string;
    relayUrl: string;
    apiKey?: string;
    reconnect?: boolean;
    reconnectAttempts?: number;
    reconnectDelay?: number;
    heartbeatInterval?: number;
    messageTimeout?: number;
}
/**
 * Routing configuration
 */
export interface RouterConfig {
    enableChannels?: boolean;
    enablePresence?: boolean;
    maxChannelsPerAgent?: number;
    presenceTTL?: number;
}
/**
 * Server configuration
 */
export interface RelayServerConfig {
    port: number;
    host?: string;
    cors?: {
        origin?: string | string[];
        credentials?: boolean;
    };
    router?: RouterConfig;
}
