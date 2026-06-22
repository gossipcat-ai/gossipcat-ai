import { randomUUID } from 'crypto';
import { MessageType, MessageEnvelope } from './protocol';

/**
 * Generate a cryptographically secure unique message ID using crypto.randomUUID()
 */
function generateMessageId(): string {
  return randomUUID();
}

/**
 * Message helper class for creating protocol messages
 */
export class Message {
  constructor(public envelope: MessageEnvelope) {}

  /**
   * Create a DIRECT message (point-to-point)
   */
  static createDirect(
    senderId: string,
    receiverId: string,
    body: Uint8Array,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.DIRECT,
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
  static createChannel(
    senderId: string,
    channelName: string,
    body: Uint8Array,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.CHANNEL,
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
  static createRpcRequest(
    senderId: string,
    receiverId: string,
    requestId: string,
    body: Uint8Array,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.RPC_REQUEST,
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
  static createRpcResponse(
    senderId: string,
    receiverId: string,
    requestId: string,
    body: Uint8Array,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.RPC_RESPONSE,
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
  static createSubscription(
    senderId: string,
    channelName: string,
    body?: Uint8Array,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.SUBSCRIPTION,
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
  static createUnsubscription(
    senderId: string,
    channelName: string,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.UNSUBSCRIPTION,
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
  static createPresence(
    senderId: string,
    body: Uint8Array,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.PRESENCE,
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
  static createPing(
    senderId: string,
    receiverId: string,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.PING,
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
  static createError(
    senderId: string,
    receiverId: string,
    errorCode: string,
    description: string,
    relatedMessageId?: string,
    options?: Partial<MessageEnvelope>
  ): Message {
    const envelope: MessageEnvelope = {
      v: 1,
      t: MessageType.ERROR,
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
  toEnvelope(): MessageEnvelope {
    return this.envelope;
  }

  /**
   * Get message type as string
   */
  getTypeName(): string {
    return MessageType[this.envelope.t];
  }

  /**
   * Check if message has compression flag set
   */
  isCompressed(): boolean {
    return (this.envelope.f & 0b00000010) !== 0;
  }

  /**
   * Check if message has authentication flag set
   */
  isAuthenticated(): boolean {
    return (this.envelope.f & 0b00000001) !== 0;
  }
}
