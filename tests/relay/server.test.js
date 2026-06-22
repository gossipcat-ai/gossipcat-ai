"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const relay_1 = require("@gossip/relay");
const ws_1 = __importDefault(require("ws"));
const types_1 = require("@gossip/types");
describe('RelayServer', () => {
    let server;
    const codec = new types_1.Codec();
    beforeAll(async () => {
        server = new relay_1.RelayServer({ port: 0 }); // random port
        await server.start();
    });
    afterAll(async () => {
        await server.stop();
    });
    async function connectAgent(agentId) {
        return new Promise((resolve, reject) => {
            const ws = new ws_1.default(server.url);
            ws.on('open', () => {
                ws.send(JSON.stringify({ type: 'auth', agentId, apiKey: 'test-key' }));
            });
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'auth_ok')
                        resolve(ws);
                    else
                        reject(new Error(`Auth failed: ${JSON.stringify(msg)}`));
                }
                catch {
                    // not JSON — ignore (might be msgpack)
                }
            });
            ws.on('error', reject);
        });
    }
    it('accepts WebSocket connections with auth', async () => {
        const ws = await connectAgent('test-agent');
        expect(ws.readyState).toBe(ws_1.default.OPEN);
        ws.close();
        // wait for close
        await new Promise(r => setTimeout(r, 50));
    });
    it('routes direct messages between agents', async () => {
        const wsA = await connectAgent('agent-a');
        const wsB = await connectAgent('agent-b');
        const received = new Promise((resolve) => {
            wsB.on('message', (data) => {
                try {
                    const envelope = codec.decode(data);
                    resolve(envelope);
                }
                catch { /* skip non-msgpack */ }
            });
        });
        const msg = types_1.Message.createDirect('agent-a', 'agent-b', new TextEncoder().encode('hello'));
        wsA.send(codec.encode(msg.envelope));
        const envelope = await received;
        expect(envelope.sid).toBe('agent-a');
        expect(envelope.rid).toBe('agent-b');
        expect(new TextDecoder().decode(envelope.body)).toBe('hello');
        wsA.close();
        wsB.close();
        await new Promise(r => setTimeout(r, 50));
    });
    it('stamps sender ID from auth (prevents impersonation)', async () => {
        const wsA = await connectAgent('real-agent');
        const wsB = await connectAgent('target');
        const received = new Promise((resolve) => {
            wsB.on('message', (data) => {
                try {
                    resolve(codec.decode(data));
                }
                catch { /* skip */ }
            });
        });
        // Try to impersonate by setting sid to 'fake-agent'
        const msg = types_1.Message.createDirect('fake-agent', 'target', new TextEncoder().encode('spoofed'));
        wsA.send(codec.encode(msg.envelope));
        const envelope = await received;
        // Server must stamp the real authenticated ID
        expect(envelope.sid).toBe('real-agent');
        wsA.close();
        wsB.close();
        await new Promise(r => setTimeout(r, 50));
    });
    it('closes connection if no auth within timeout', async () => {
        const shortServer = new relay_1.RelayServer({ port: 0, authTimeoutMs: 200 });
        await shortServer.start();
        const ws = new ws_1.default(shortServer.url);
        const closed = new Promise((resolve) => {
            ws.on('close', (code) => resolve(code));
        });
        // Don't send auth — wait for timeout
        const code = await closed;
        expect(code).toBe(1008);
        await shortServer.stop();
    }, 5000);
    it('health check returns status', async () => {
        const res = await fetch(`http://localhost:${server.port}/health`);
        const data = await res.json();
        expect(data.status).toBe('ok');
        expect(typeof data.connections).toBe('number');
    });
    it('returns 404 for unknown paths', async () => {
        const res = await fetch(`http://localhost:${server.port}/unknown`);
        expect(res.status).toBe(404);
    });
});
//# sourceMappingURL=server.test.js.map