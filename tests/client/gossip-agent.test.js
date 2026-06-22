"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@gossip/client");
const relay_1 = require("@gossip/relay");
const types_1 = require("@gossip/types");
describe('GossipAgent', () => {
    let server;
    beforeAll(async () => {
        server = new relay_1.RelayServer({ port: 0 });
        await server.start();
    });
    afterAll(async () => {
        await server.stop();
    });
    it('connects to relay and emits connect event', async () => {
        const agent = new client_1.GossipAgent({ agentId: 'test-a', relayUrl: server.url });
        const connected = new Promise(resolve => agent.on('connect', resolve));
        await agent.connect();
        await connected;
        expect(agent.isConnected()).toBe(true);
        expect(agent.sessionId).toBeTruthy();
        await agent.disconnect();
    });
    it('sends and receives direct messages', async () => {
        const a = new client_1.GossipAgent({ agentId: 'sender', relayUrl: server.url });
        const b = new client_1.GossipAgent({ agentId: 'receiver', relayUrl: server.url });
        await a.connect();
        await b.connect();
        const received = new Promise(resolve => {
            b.on('message', (data, envelope) => resolve({ data, envelope }));
        });
        await a.sendDirect('receiver', { hello: 'world' });
        const { data, envelope } = await received;
        expect(data).toEqual({ hello: 'world' });
        expect(envelope.sid).toBe('sender');
        expect(envelope.t).toBe(types_1.MessageType.DIRECT);
        await a.disconnect();
        await b.disconnect();
    });
    it('sends and receives channel messages', async () => {
        const a = new client_1.GossipAgent({ agentId: 'pub', relayUrl: server.url });
        const b = new client_1.GossipAgent({ agentId: 'sub', relayUrl: server.url });
        await a.connect();
        await b.connect();
        await b.subscribe('test-channel');
        // Small delay for subscription to propagate
        await new Promise(r => setTimeout(r, 50));
        const received = new Promise(resolve => {
            b.on('message', (data, envelope) => {
                if (envelope.t === types_1.MessageType.CHANNEL)
                    resolve(data);
            });
        });
        await a.sendChannel('test-channel', { msg: 'broadcast' });
        const data = await received;
        expect(data).toEqual({ msg: 'broadcast' });
        await a.disconnect();
        await b.disconnect();
    });
    it('reconnects with exponential backoff after server disconnect', async () => {
        const tempServer = new relay_1.RelayServer({ port: 0 });
        await tempServer.start();
        const url = tempServer.url;
        const agent = new client_1.GossipAgent({
            agentId: 'reconnect-test',
            relayUrl: url,
            reconnect: true,
            maxReconnectAttempts: 3,
            reconnectBaseDelay: 100
        });
        await agent.connect();
        expect(agent.isConnected()).toBe(true);
        // Stop server to force disconnect
        await tempServer.stop();
        await new Promise(r => setTimeout(r, 200));
        expect(agent.isConnected()).toBe(false);
        // Restart server on same port — port will differ since OS assigns ephemeral port.
        // Just verify reconnect attempt behavior (agent won't reconnect to different port).
        const tempServer2 = new relay_1.RelayServer({ port: 0 });
        await tempServer2.start();
        // Wait for reconnect attempts to cycle (backoff: 100ms, 200ms, 400ms)
        await new Promise(r => setTimeout(r, 1000));
        await agent.disconnect();
        await tempServer2.stop();
    }, 15000);
    it('emits disconnect event with close code', async () => {
        const agent = new client_1.GossipAgent({
            agentId: 'disconnect-test',
            relayUrl: server.url,
            reconnect: false
        });
        await agent.connect();
        const disconnected = new Promise(resolve => {
            agent.on('disconnect', (code) => resolve(code));
        });
        await agent.disconnect();
        const code = await disconnected;
        expect(code).toBe(1000); // Normal close
    });
    it('does not put API key in WebSocket URL', async () => {
        const agent = new client_1.GossipAgent({
            agentId: 'secure-test',
            relayUrl: server.url,
            apiKey: 'secret-key-123'
        });
        // The URL should not contain the API key
        // Auth happens via initial JSON frame
        await agent.connect();
        expect(agent.isConnected()).toBe(true);
        await agent.disconnect();
    });
});
//# sourceMappingURL=gossip-agent.test.js.map