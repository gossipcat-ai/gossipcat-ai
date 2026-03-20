/**
 * Gossip Mesh Protocol: MessagePack Codec
 *
 * Encoder/decoder using MessagePack for efficient binary serialization.
 */
import { MessageEnvelope } from './protocol';
/**
 * Codec for encoding and decoding MessageEnvelope to/from MessagePack binary format
 */
export declare class Codec {
    /**
     * Encode a MessageEnvelope to MessagePack binary format
     *
     * Field order per spec: v, t, f, id, sid, rid, ts, seq, ttl, meta, body
     * Optional fields (rid_req, meta) included only if present
     */
    encode(envelope: MessageEnvelope): Uint8Array;
    /**
     * Decode MessagePack binary data to MessageEnvelope
     *
     * @throws Error if data is malformed or invalid
     */
    decode(data: Uint8Array): MessageEnvelope;
    /**
     * Validate a MessageEnvelope has all required fields and correct types
     *
     * @throws Error if validation fails
     */
    private validateEnvelope;
    /**
     * Return the encoded byte length of an envelope
     */
    estimateSize(envelope: MessageEnvelope): number;
}
/**
 * Default codec instance for convenience
 */
export declare const codec: Codec;
