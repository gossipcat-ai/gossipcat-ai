import { RelayServer } from '@gossip/relay';
import WebSocket from 'ws';
import { Codec, Message } from '@gossip/types';

describe('RelayServer', () => {
  let server: RelayServer;
  const codec = new Codec();

  beforeAll(async () => {
    server = new RelayServer({ port: 0 }); // random port
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  async function connectAgent(agentId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(server.url);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', agentId }));
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth_ok') resolve(ws);
          else reject(new Error(`Auth failed: ${JSON.stringify(msg)}`));
        } catch {
          // not JSON — ignore (might be msgpack)
        }
      });
      ws.on('error', reject);
    });
  }

  it('accepts WebSocket connections with auth', async () => {
    const ws = await connectAgent('test-agent');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    // wait for close
    await new Promise(r => setTimeout(r, 50));
  });

  it('routes direct messages between agents', async () => {
    const wsA = await connectAgent('agent-a');
    const wsB = await connectAgent('agent-b');

    const received = new Promise<any>((resolve) => {
      wsB.on('message', (data) => {
        try {
          const envelope = codec.decode(data as Buffer);
          resolve(envelope);
        } catch { /* skip non-msgpack */ }
      });
    });

    const msg = Message.createDirect('agent-a', 'agent-b', new TextEncoder().encode('hello'));
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

    const received = new Promise<any>((resolve) => {
      wsB.on('message', (data) => {
        try {
          resolve(codec.decode(data as Buffer));
        } catch { /* skip */ }
      });
    });

    // Try to impersonate by setting sid to 'fake-agent'
    const msg = Message.createDirect('fake-agent', 'target', new TextEncoder().encode('spoofed'));
    wsA.send(codec.encode(msg.envelope));

    const envelope = await received;
    // Server must stamp the real authenticated ID
    expect(envelope.sid).toBe('real-agent');

    wsA.close();
    wsB.close();
    await new Promise(r => setTimeout(r, 50));
  });

  it('closes connection if no auth within timeout', async () => {
    const shortServer = new RelayServer({ port: 0, authTimeoutMs: 200 });
    await shortServer.start();

    const ws = new WebSocket(shortServer.url);
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    // Don't send auth — wait for timeout
    const code = await closed;
    expect(code).toBe(1008);

    await shortServer.stop();
  }, 5000);

  it('health check returns status', async () => {
    const res = await fetch(`http://localhost:${server.port}/health`);
    const data = await res.json() as { status: string; connections: number };
    expect(data.status).toBe('ok');
    expect(typeof data.connections).toBe('number');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`http://localhost:${server.port}/unknown`);
    expect(res.status).toBe(404);
  });
});
