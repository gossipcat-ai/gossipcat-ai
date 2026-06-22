/**
 * Gossip Mesh Protocol: MessagePack Codec
 *
 * Encoder/decoder using MessagePack for efficient binary serialization.
 */

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { MessageEnvelope, FieldNames, MessageType } from './protocol';

/**
 * Codec for encoding and decoding MessageEnvelope to/from MessagePack binary format
 */
export class Codec {
  /**
   * Encode a MessageEnvelope to MessagePack binary format
   *
   * Field order per spec: v, t, f, id, sid, rid, ts, seq, ttl, meta, body
   * Optional fields (rid_req, meta) included only if present
   */
  encode(envelope: MessageEnvelope): Uint8Array {
    this.validateEnvelope(envelope);

    const wireFormat: Record<string, unknown> = {
      [FieldNames.version]: envelope.v,
      [FieldNames.messageType]: envelope.t,
      [FieldNames.flags]: envelope.f,
      [FieldNames.messageId]: envelope.id,
      [FieldNames.senderId]: envelope.sid,
      [FieldNames.receiverId]: envelope.rid,
      [FieldNames.timestamp]: envelope.ts,
      [FieldNames.sequence]: envelope.seq,
      [FieldNames.ttl]: envelope.ttl,
      [FieldNames.body]: envelope.body
    };

    if (envelope.rid_req !== undefined) {
      wireFormat[FieldNames.requestId] = envelope.rid_req;
    }

    if (envelope.meta !== undefined && Object.keys(envelope.meta).length > 0) {
      wireFormat[FieldNames.metadata] = envelope.meta;
    }

    return msgpackEncode(wireFormat) as Uint8Array;
  }

  /**
   * Decode MessagePack binary data to MessageEnvelope
   *
   * @throws Error if data is malformed or invalid
   */
  decode(data: Uint8Array): MessageEnvelope {
    let decoded: unknown;
    try {
      decoded = msgpackDecode(data);
    } catch (error) {
      throw new Error(`Failed to decode MessagePack: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    if (typeof decoded !== 'object' || decoded === null) {
      throw new Error('Decoded data is not an object');
    }

    const d = decoded as Record<string, unknown>;

    const envelope: MessageEnvelope = {
      v: d[FieldNames.version] as number,
      t: d[FieldNames.messageType] as MessageType,
      f: d[FieldNames.flags] as number,
      id: d[FieldNames.messageId] as string,
      sid: d[FieldNames.senderId] as string,
      rid: d[FieldNames.receiverId] as string,
      ts: d[FieldNames.timestamp] as number,
      seq: d[FieldNames.sequence] as number,
      ttl: d[FieldNames.ttl] as number,
      body: d[FieldNames.body] as Uint8Array
    };

    if (d[FieldNames.requestId] !== undefined) {
      envelope.rid_req = d[FieldNames.requestId] as string;
    }

    if (d[FieldNames.metadata] !== undefined) {
      envelope.meta = d[FieldNames.metadata] as Record<string, unknown>;
    }

    this.validateEnvelope(envelope);

    return envelope;
  }

  /**
   * Validate a MessageEnvelope has all required fields and correct types
   *
   * @throws Error if validation fails
   */
  private validateEnvelope(envelope: MessageEnvelope): void {
    if (typeof envelope.v !== 'number' || envelope.v !== 1) {
      throw new Error(`Invalid version: expected 1, got ${envelope.v}`);
    }

    if (typeof envelope.t !== 'number' || envelope.t < 1 || envelope.t > 9) {
      throw new Error(`Invalid message type: expected 1-9, got ${envelope.t}`);
    }

    if (typeof envelope.f !== 'number' || envelope.f < 0 || envelope.f > 255) {
      throw new Error(`Invalid flags: expected 0-255, got ${envelope.f}`);
    }

    if (typeof envelope.id !== 'string' || envelope.id.length === 0) {
      throw new Error('Invalid message ID: must be non-empty string');
    }

    if (typeof envelope.sid !== 'string' || envelope.sid.length === 0) {
      throw new Error('Invalid sender ID: must be non-empty string');
    }

    if (typeof envelope.rid !== 'string') {
      throw new Error('Invalid receiver ID: must be string');
    }

    if (envelope.t === MessageType.RPC_RESPONSE || envelope.t === MessageType.RPC_REQUEST) {
      if (typeof envelope.rid_req !== 'string' || envelope.rid_req.length === 0) {
        throw new Error('Request ID required for RPC messages');
      }
    }

    if (typeof envelope.ts !== 'number' || envelope.ts < 0) {
      throw new Error('Invalid timestamp: must be non-negative number');
    }

    if (typeof envelope.seq !== 'number' || envelope.seq < 0) {
      throw new Error('Invalid sequence: must be non-negative number');
    }

    if (typeof envelope.ttl !== 'number' || envelope.ttl < 0 || envelope.ttl > 65535) {
      throw new Error('Invalid TTL: must be 0-65535');
    }

    if (envelope.meta !== undefined) {
      if (typeof envelope.meta !== 'object' || envelope.meta === null) {
        throw new Error('Invalid metadata: must be object');
      }
      for (const [key, value] of Object.entries(envelope.meta)) {
        if (typeof key !== 'string') {
          throw new Error('Invalid metadata: all keys must be strings');
        }
        const valueType = typeof value;
        if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean' && value !== null) {
          throw new Error(`Invalid metadata: value for key "${key}" must be string, number, boolean, or null`);
        }
      }
    }

    if (!(envelope.body instanceof Uint8Array)) {
      throw new Error('Invalid body: must be Uint8Array');
    }
  }

  /**
   * Return the encoded byte length of an envelope
   */
  estimateSize(envelope: MessageEnvelope): number {
    return this.encode(envelope).length;
  }
}

/**
 * Default codec instance for convenience
 */
export const codec = new Codec();
