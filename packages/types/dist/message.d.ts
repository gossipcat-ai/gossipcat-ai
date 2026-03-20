import { MessageEnvelope } from './protocol';
/**
 * Message helper class for creating protocol messages
 */
export declare class Message {
    envelope: MessageEnvelope;
    constructor(envelope: MessageEnvelope);
    /**
     * Create a DIRECT message (point-to-point)
     */
    static createDirect(senderId: string, receiverId: string, body: Uint8Array, options?: Partial<MessageEnvelope>): Message;
    /**
     * Create a CHANNEL message (pub-sub broadcast)
     */
    static createChannel(senderId: string, channelName: string, body: Uint8Array, options?: Partial<MessageEnvelope>): Message;
    /**
     * Create an RPC_REQUEST message
     */
    static createRpcRequest(senderId: string, receiverId: string, requestId: string, body: Uint8Array, options?: Partial<MessageEnvelope>): Message;
    /**
     * Create an RPC_RESPONSE message
     */
    static createRpcResponse(senderId: string, receiverId: string, requestId: string, body: Uint8Array, options?: Partial<MessageEnvelope>): Message;
    /**
     * Create a SUBSCRIPTION message
     */
    static createSubscription(senderId: string, channelName: string, body?: Uint8Array, options?: Partial<MessageEnvelope>): Message;
    /**
     * Create an UNSUBSCRIPTION message
     */
    static createUnsubscription(senderId: string, channelName: string, options?: Partial<MessageEnvelope>): Message;
    /**
     * Create a PRESENCE message
     */
    static createPresence(senderId: string, body: Uint8Array, options?: Partial<MessageEnvelope>): Message;
    /**
     * Create a PING message
     */
    static createPing(senderId: string, receiverId: string, options?: Partial<MessageEnvelope>): Message;
    /**
     * Create an ERROR message
     */
    static createError(senderId: string, receiverId: string, errorCode: string, description: string, relatedMessageId?: string, options?: Partial<MessageEnvelope>): Message;
    /**
     * Get the envelope
     */
    toEnvelope(): MessageEnvelope;
    /**
     * Get message type as string
     */
    getTypeName(): string;
    /**
     * Check if message has compression flag set
     */
    isCompressed(): boolean;
    /**
     * Check if message has authentication flag set
     */
    isAuthenticated(): boolean;
}
