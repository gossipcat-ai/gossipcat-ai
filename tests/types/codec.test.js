"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("@gossip/types");
const crypto_1 = require("crypto");
describe('Codec', () => {
    const codec = new types_1.Codec();
    it('encodes and decodes a DIRECT message round-trip', () => {
        const envelope = {
            v: 1, t: types_1.MessageType.DIRECT, f: 0,
            id: (0, crypto_1.randomUUID)(), sid: 'agent-a', rid: 'agent-b',
            ts: Date.now(), seq: 1, ttl: 300,
            body: new TextEncoder().encode('hello')
        };
        const encoded = codec.encode(envelope);
        expect(encoded).toBeInstanceOf(Uint8Array);
        expect(encoded.length).toBeGreaterThan(0);
        const decoded = codec.decode(encoded);
        expect(decoded.v).toBe(1);
        expect(decoded.t).toBe(types_1.MessageType.DIRECT);
        expect(decoded.sid).toBe('agent-a');
        expect(decoded.rid).toBe('agent-b');
        expect(new TextDecoder().decode(decoded.body)).toBe('hello');
    });
    it('preserves optional fields (rid_req, meta)', () => {
        const envelope = {
            v: 1, t: types_1.MessageType.RPC_RESPONSE, f: 0,
            id: (0, crypto_1.randomUUID)(), sid: 'a', rid: 'b', rid_req: 'req-123',
            ts: Date.now(), seq: 0, ttl: 30,
            meta: { status: 'ok', code: 200 },
            body: new Uint8Array(0)
        };
        const decoded = codec.decode(codec.encode(envelope));
        expect(decoded.rid_req).toBe('req-123');
        expect(decoded.meta).toEqual({ status: 'ok', code: 200 });
    });
    it('rejects invalid version', () => {
        const bad = { v: 2, t: 1, f: 0, id: 'x', sid: 'a', rid: 'b', ts: 0, seq: 0, ttl: 0, body: new Uint8Array(0) };
        expect(() => codec.encode(bad)).toThrow('Invalid version');
    });
    it('rejects invalid message type', () => {
        const bad = { v: 1, t: 99, f: 0, id: 'x', sid: 'a', rid: 'b', ts: 0, seq: 0, ttl: 0, body: new Uint8Array(0) };
        expect(() => codec.encode(bad)).toThrow('Invalid message type');
    });
    it('handles all 9 message types', () => {
        for (let t = 1; t <= 9; t++) {
            const envelope = {
                v: 1, t: t, f: 0, id: (0, crypto_1.randomUUID)(), sid: 'a', rid: 'b',
                ...(t === 3 || t === 4 ? { rid_req: 'req-1' } : {}),
                ts: Date.now(), seq: 0, ttl: 30, body: new Uint8Array(0)
            };
            const decoded = codec.decode(codec.encode(envelope));
            expect(decoded.t).toBe(t);
        }
    });
});
//# sourceMappingURL=codec.test.js.map