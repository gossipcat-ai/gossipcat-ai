"use strict";
/**
 * Gossip Mesh Protocol: MessagePack Codec
 *
 * Encoder/decoder using MessagePack for efficient binary serialization.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.codec = exports.Codec = void 0;
const msgpack_1 = require("@msgpack/msgpack");
const protocol_1 = require("./protocol");
/**
 * Codec for encoding and decoding MessageEnvelope to/from MessagePack binary format
 */
class Codec {
    /**
     * Encode a MessageEnvelope to MessagePack binary format
     *
     * Field order per spec: v, t, f, id, sid, rid, ts, seq, ttl, meta, body
     * Optional fields (rid_req, meta) included only if present
     */
    encode(envelope) {
        this.validateEnvelope(envelope);
        const wireFormat = {
            [protocol_1.FieldNames.version]: envelope.v,
            [protocol_1.FieldNames.messageType]: envelope.t,
            [protocol_1.FieldNames.flags]: envelope.f,
            [protocol_1.FieldNames.messageId]: envelope.id,
            [protocol_1.FieldNames.senderId]: envelope.sid,
            [protocol_1.FieldNames.receiverId]: envelope.rid,
            [protocol_1.FieldNames.timestamp]: envelope.ts,
            [protocol_1.FieldNames.sequence]: envelope.seq,
            [protocol_1.FieldNames.ttl]: envelope.ttl,
            [protocol_1.FieldNames.body]: envelope.body
        };
        if (envelope.rid_req !== undefined) {
            wireFormat[protocol_1.FieldNames.requestId] = envelope.rid_req;
        }
        if (envelope.meta !== undefined && Object.keys(envelope.meta).length > 0) {
            wireFormat[protocol_1.FieldNames.metadata] = envelope.meta;
        }
        return (0, msgpack_1.encode)(wireFormat);
    }
    /**
     * Decode MessagePack binary data to MessageEnvelope
     *
     * @throws Error if data is malformed or invalid
     */
    decode(data) {
        let decoded;
        try {
            decoded = (0, msgpack_1.decode)(data);
        }
        catch (error) {
            throw new Error(`Failed to decode MessagePack: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        if (typeof decoded !== 'object' || decoded === null) {
            throw new Error('Decoded data is not an object');
        }
        const d = decoded;
        const envelope = {
            v: d[protocol_1.FieldNames.version],
            t: d[protocol_1.FieldNames.messageType],
            f: d[protocol_1.FieldNames.flags],
            id: d[protocol_1.FieldNames.messageId],
            sid: d[protocol_1.FieldNames.senderId],
            rid: d[protocol_1.FieldNames.receiverId],
            ts: d[protocol_1.FieldNames.timestamp],
            seq: d[protocol_1.FieldNames.sequence],
            ttl: d[protocol_1.FieldNames.ttl],
            body: d[protocol_1.FieldNames.body]
        };
        if (d[protocol_1.FieldNames.requestId] !== undefined) {
            envelope.rid_req = d[protocol_1.FieldNames.requestId];
        }
        if (d[protocol_1.FieldNames.metadata] !== undefined) {
            envelope.meta = d[protocol_1.FieldNames.metadata];
        }
        this.validateEnvelope(envelope);
        return envelope;
    }
    /**
     * Validate a MessageEnvelope has all required fields and correct types
     *
     * @throws Error if validation fails
     */
    validateEnvelope(envelope) {
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
        if (envelope.t === protocol_1.MessageType.RPC_RESPONSE || envelope.t === protocol_1.MessageType.RPC_REQUEST) {
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
    estimateSize(envelope) {
        return this.encode(envelope).length;
    }
}
exports.Codec = Codec;
/**
 * Default codec instance for convenience
 */
exports.codec = new Codec();
//# sourceMappingURL=codec.js.map