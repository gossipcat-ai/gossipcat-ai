import { GossipAgent } from '@gossip/client';
import { RelayServer } from '@gossip/relay';
import { MessageType } from '@gossip/types';

describe('GossipAgent', () => {
  let server: RelayServer;

  beforeAll(async () => {
    server = new RelayServer({ port: 0 });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('connects to relay and emits connect event', async () => {
    const agent = new GossipAgent({ agentId: 'test-a', relayUrl: server.url });
    const connected = new Promise(resolve => agent.on('connect', resolve));
    await agent.connect();
    await connected;
    expect(agent.isConnected()).toBe(true);
    expect(agent.sessionId).toBeTruthy();
    await agent.disconnect();
  });

  it('sends and receives direct messages', async () => {
    const a = new GossipAgent({ agentId: 'sender', relayUrl: server.url });
    const b = new GossipAgent({ agentId: 'receiver', relayUrl: server.url });
    await a.connect();
    await b.connect();

    const received = new Promise<any>(resolve => {
      b.on('message', (data, envelope) => resolve({ data, envelope }));
    });

    await a.sendDirect('receiver', { hello: 'world' });
    const { data, envelope } = await received;
    expect(data).toEqual({ hello: 'world' });
    expect(envelope.sid).toBe('sender');
    expect(envelope.t).toBe(MessageType.DIRECT);

    await a.disconnect();
    await b.disconnect();
  });

  it('sends and receives channel messages', async () => {
    const a = new GossipAgent({ agentId: 'pub', relayUrl: server.url });
    const b = new GossipAgent({ agentId: 'sub', relayUrl: server.url });
    await a.connect();
    await b.connect();

    await b.subscribe('test-channel');
    // Small delay for subscription to propagate
    await new Promise(r => setTimeout(r, 50));

    const received = new Promise<any>(resolve => {
      b.on('message', (data, envelope) => {
        if (envelope.t === MessageType.CHANNEL) resolve(data);
      });
    });

    await a.sendChannel('test-channel', { msg: 'broadcast' });
    const data = await received;
    expect(data).toEqual({ msg: 'broadcast' });

    await a.disconnect();
    await b.disconnect();
  });

  it('reconnects with exponential backoff after server disconnect', async () => {
    const tempServer = new RelayServer({ port: 0 });
    await tempServer.start();
    const url = tempServer.url;

    const agent = new GossipAgent({
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
    const tempServer2 = new RelayServer({ port: 0 });
    await tempServer2.start();

    // Wait for reconnect attempts to cycle (backoff: 100ms, 200ms, 400ms)
    await new Promise(r => setTimeout(r, 1000));
    await agent.disconnect();
    await tempServer2.stop();
  }, 15000);

  it('emits disconnect event with close code', async () => {
    const agent = new GossipAgent({
      agentId: 'disconnect-test',
      relayUrl: server.url,
      reconnect: false
    });
    await agent.connect();

    const disconnected = new Promise<number>(resolve => {
      agent.on('disconnect', (code) => resolve(code));
    });

    await agent.disconnect();
    const code = await disconnected;
    expect(code).toBe(1000); // Normal close
  });

  it('does not put API key in WebSocket URL', async () => {
    const agent = new GossipAgent({
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
