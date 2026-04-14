/**
 * Relay heartbeat tests
 *
 * Verifies the WS-level heartbeat added in PR 1 of
 * docs/specs/2026-04-15-relay-lifecycle-stability.md:
 *   - A heartbeat ping fires on every interval tick.
 *   - A client that replies to the ping (default ws auto-pong) is NOT terminated.
 *   - A client that withholds pong IS terminated on the next tick.
 *   - The heartbeat interval is cleared on server.stop() and does not leak.
 *
 * We use fake timers for the first two and a short real interval for the
 * missing-pong termination test so we can assert `terminate()` was invoked
 * via ws events without fighting async pong scheduling under fake timers.
 */

import { RelayServer } from '@gossip/relay';
import WebSocket from 'ws';

const AUTH_KEY = 'heartbeat-test-key';

async function connectAuthed(url: string, agentId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', agentId, apiKey: AUTH_KEY }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_ok') resolve(ws);
      } catch { /* non-JSON frames after auth */ }
    });
    ws.on('error', reject);
  });
}

describe('RelayServer heartbeat', () => {
  it('pings authenticated clients on each interval tick (clients that pong are not terminated)', async () => {
    const server = new RelayServer({
      port: 0,
      apiKey: AUTH_KEY,
      heartbeatIntervalMs: 100, // short for test
    });
    await server.start();

    try {
      const ws = await connectAuthed(server.url, 'ping-target');

      let pingCount = 0;
      ws.on('ping', () => { pingCount++; });

      // Wait ~3 intervals — by default `ws` auto-replies with pong, so the
      // server should see liveness and NOT terminate.
      await new Promise(r => setTimeout(r, 350));

      expect(pingCount).toBeGreaterThanOrEqual(2);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
      await new Promise(r => setTimeout(r, 50));
    } finally {
      await server.stop();
    }
  }, 5000);

  it('terminates clients that withhold pong on the next tick', async () => {
    const server = new RelayServer({
      port: 0,
      apiKey: AUTH_KEY,
      heartbeatIntervalMs: 80,
    });
    await server.start();

    try {
      const ws = await connectAuthed(server.url, 'silent-client');

      // Swallow pings — do NOT let ws auto-respond with pong. The `ws`
      // library auto-ponges when you attach no ping handler that
      // interferes, but we can defeat that by pausing the socket on ping.
      // Simplest: monkey-patch the underlying `pong` to a no-op.
      (ws as unknown as { pong: (...args: unknown[]) => void }).pong = () => { /* withhold */ };

      const closed = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code));
      });

      // Tick 1: server marks pendingPong=true, sends ping. Client withholds pong.
      // Tick 2: server sees pendingPong still true → terminate().
      // Allow a generous window for Node timer jitter.
      const code = await Promise.race([
        closed,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('ws was not terminated')), 1000),
        ),
      ]);
      // terminate() yields code 1006 (abnormal closure) on the client side.
      expect(typeof code).toBe('number');
    } finally {
      await server.stop();
    }
  }, 5000);

  it('stops the heartbeat interval on server.stop() (no leaked timers)', async () => {
    const server = new RelayServer({
      port: 0,
      apiKey: AUTH_KEY,
      heartbeatIntervalMs: 50,
    });
    await server.start();

    // Poke private field to confirm interval was started. We avoid exporting
    // a public getter because it's an implementation detail; `as any` here is
    // scoped to the test, not production code (the constraint in the spec is
    // about production code, which uses a typed WeakMap).
    const privateView = server as unknown as { heartbeatInterval: unknown };
    expect(privateView.heartbeatInterval).not.toBeNull();

    await server.stop();

    expect(privateView.heartbeatInterval).toBeNull();
  }, 5000);

  it('respects heartbeatIntervalMs=0 (disabled, for tests)', async () => {
    const server = new RelayServer({
      port: 0,
      apiKey: AUTH_KEY,
      heartbeatIntervalMs: 0,
    });
    await server.start();

    const privateView = server as unknown as { heartbeatInterval: unknown };
    expect(privateView.heartbeatInterval).toBeNull();

    await server.stop();
  }, 5000);
});
