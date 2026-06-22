/**
 * @gossip/types - Protocol constants and wire format types
 *
 * Shared TypeScript type definitions for Gossip Mesh protocol.
 * Used by relay, client, and orchestrator packages.
 */

/**
 * Message type discriminators (1-9)
 */
export enum MessageType {
  DIRECT = 1,         // Point-to-point messaging
  CHANNEL = 2,        // Pub-sub broadcast
  RPC_REQUEST = 3,    // Request-reply pattern
  RPC_RESPONSE = 4,   // Response to RPC
  SUBSCRIPTION = 5,   // Subscribe to channel
  UNSUBSCRIPTION = 6, // Unsubscribe from channel
  PRESENCE = 7,       // Agent status/heartbeat
  PING = 8,           // Keep-alive
  ERROR = 9           // Error reporting
}

/**
 * Short field names for wire format (minimize overhead)
 */
export const FieldNames = {
  version: 'v',
  messageType: 't',
  flags: 'f',
  messageId: 'id',
  senderId: 'sid',
  receiverId: 'rid',
  requestId: 'rid_req',
  timestamp: 'ts',
  sequence: 'seq',
  ttl: 'ttl',
  metadata: 'meta',
  body: 'body'
} as const;

/**
 * MessageEnvelope structure (11 core fields)
 * This is the wire format that gets encoded with MessagePack
 */
export interface MessageEnvelope {
  v: number;           // version (u8) - Protocol version, currently 1
  t: MessageType;      // message_type (u8) - Type discriminator 1-9
  f: number;           // flags (u8) - Bit flags for compression, auth, etc.
  id: string;          // message_id (string) - UUID for dedup/tracking
  sid: string;         // sender_id (string) - Agent ID of sender
  rid: string;         // receiver_id (string) - Agent ID or channel name
  rid_req?: string;    // request_id (string, optional) - For RPC responses
  ts: number;          // timestamp (i64) - Milliseconds since UNIX epoch
  seq: number;         // sequence (u32) - Per-connection sequence number
  ttl: number;         // ttl (u16) - Time-to-live in seconds (0 = infinite)
  meta?: Record<string, any>; // metadata (map, optional) - Headers/routing hints
  body: Uint8Array;    // body (bytes) - Serialized payload content
}

/**
 * Transport types
 */
export type TransportType = 'websocket' | 'http' | 'auto';

export enum TransportState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  CLOSED = 'closed'
}

/**
 * Connection states
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

/**
 * Presence status
 */
export enum PresenceStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  AWAY = 'away',
  BUSY = 'busy'
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
