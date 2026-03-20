"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Message = void 0;
const crypto_1 = require("crypto");
const protocol_1 = require("./protocol");
/**
 * Generate a cryptographically secure unique message ID using crypto.randomUUID()
 */
function generateMessageId() {
    return (0, crypto_1.randomUUID)();
}
/**
 * Message helper class for creating protocol messages
 */
class Message {
    envelope;
    constructor(envelope) {
        this.envelope = envelope;
    }
    /**
     * Create a DIRECT message (point-to-point)
     */
    static createDirect(senderId, receiverId, body, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.DIRECT,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: receiverId,
            ts: Date.now(),
            seq: 0,
            ttl: 300,
            body,
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Create a CHANNEL message (pub-sub broadcast)
     */
    static createChannel(senderId, channelName, body, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.CHANNEL,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: channelName,
            ts: Date.now(),
            seq: 0,
            ttl: 600,
            body,
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Create an RPC_REQUEST message
     */
    static createRpcRequest(senderId, receiverId, requestId, body, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.RPC_REQUEST,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: receiverId,
            rid_req: requestId,
            ts: Date.now(),
            seq: 0,
            ttl: 30,
            body,
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Create an RPC_RESPONSE message
     */
    static createRpcResponse(senderId, receiverId, requestId, body, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.RPC_RESPONSE,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: receiverId,
            rid_req: requestId,
            ts: Date.now(),
            seq: 0,
            ttl: 30,
            body,
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Create a SUBSCRIPTION message
     */
    static createSubscription(senderId, channelName, body, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.SUBSCRIPTION,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: channelName,
            ts: Date.now(),
            seq: 0,
            ttl: 0,
            body: body || new Uint8Array(0),
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Create an UNSUBSCRIPTION message
     */
    static createUnsubscription(senderId, channelName, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.UNSUBSCRIPTION,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: channelName,
            ts: Date.now(),
            seq: 0,
            ttl: 0,
            body: new Uint8Array(0),
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Create a PRESENCE message
     */
    static createPresence(senderId, body, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.PRESENCE,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: '',
            ts: Date.now(),
            seq: 0,
            ttl: 60,
            body,
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Create a PING message
     */
    static createPing(senderId, receiverId, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.PING,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: receiverId,
            ts: Date.now(),
            seq: 0,
            ttl: 0,
            body: new Uint8Array(0),
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Create an ERROR message
     */
    static createError(senderId, receiverId, errorCode, description, relatedMessageId, options) {
        const envelope = {
            v: 1,
            t: protocol_1.MessageType.ERROR,
            f: 0,
            id: generateMessageId(),
            sid: senderId,
            rid: receiverId,
            rid_req: relatedMessageId,
            ts: Date.now(),
            seq: 0,
            ttl: 0,
            meta: {
                error_code: errorCode,
                description: description,
                ...options?.meta
            },
            body: new Uint8Array(0),
            ...options
        };
        return new Message(envelope);
    }
    /**
     * Get the envelope
     */
    toEnvelope() {
        return this.envelope;
    }
    /**
     * Get message type as string
     */
    getTypeName() {
        return protocol_1.MessageType[this.envelope.t];
    }
    /**
     * Check if message has compression flag set
     */
    isCompressed() {
        return (this.envelope.f & 0b00000010) !== 0;
    }
    /**
     * Check if message has authentication flag set
     */
    isAuthenticated() {
        return (this.envelope.f & 0b00000001) !== 0;
    }
}
exports.Message = Message;
//# sourceMappingURL=message.js.map