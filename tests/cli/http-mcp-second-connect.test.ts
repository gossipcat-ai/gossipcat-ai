/**
 * Regression test for issue #405 — HTTP MCP transport "Already connected to a
 * transport" crash.
 *
 * Before the fix, a single module-level McpServer was reused for every inbound
 * HTTP session. The MCP SDK's Protocol class throws
 *   "Already connected to a transport. Call close() before connecting to a
 *    new transport, or use a separate Protocol instance per connection."
 * on the second `.connect()`, so the HTTP daemon crashed on the first inbound
 * MCP request after boot.
 *
 * The fix factors the McpServer construction + 23 server.tool registrations
 * into `createMcpServer()`, which the HTTP path now invokes per session. The
 * stdio path (single connection per node process) also goes through the
 * factory but is unaffected by this bug.
 *
 * This test uses InMemoryTransport (Approach B from the task) to:
 *   1. Construct two independent McpServer instances via the factory.
 *   2. Connect each to its own transport pair without throwing.
 *   3. Confirm that calling .connect() twice on the SAME server still throws —
 *      so the test would have caught the original bug had it existed.
 */
process.env.GOSSIPCAT_MCP_NO_MAIN = '1';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../apps/cli/src/mcp-server-sdk';

describe('issue #405 — fresh McpServer per HTTP session', () => {
  it('createMcpServer returns distinct instances', () => {
    const a = createMcpServer();
    const b = createMcpServer();
    expect(a).not.toBe(b);
    // Both should expose .connect (the Protocol method that previously threw)
    expect(typeof (a as any).connect).toBe('function');
    expect(typeof (b as any).connect).toBe('function');
  });

  it('two factory-created servers can each .connect() once without "Already connected" error', async () => {
    const serverA = createMcpServer();
    const serverB = createMcpServer();

    const [aServerSide] = InMemoryTransport.createLinkedPair();
    const [bServerSide] = InMemoryTransport.createLinkedPair();

    // Issue #405: this second connect() used to throw when both servers were
    // the same singleton instance. With per-session factory, both succeed.
    await expect(serverA.connect(aServerSide)).resolves.not.toThrow();
    await expect(serverB.connect(bServerSide)).resolves.not.toThrow();

    // Cleanup — release transports so jest exits cleanly.
    await serverA.close().catch(() => {});
    await serverB.close().catch(() => {});
  });

  it('regression sentinel — calling .connect() twice on the SAME server still throws', async () => {
    const server = createMcpServer();
    const [t1] = InMemoryTransport.createLinkedPair();
    const [t2] = InMemoryTransport.createLinkedPair();

    await server.connect(t1);
    // This is the SDK guard the fix routes AROUND by creating a fresh server
    // per session. The guard itself must remain intact — if the SDK ever
    // relaxes it, we want this test to flip red so we revisit the design.
    await expect(server.connect(t2)).rejects.toThrow(/Already connected/i);

    await server.close().catch(() => {});
  });
});
