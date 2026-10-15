/**
 * gossip_tools must list every enabled tool from the live MCP registry
 * (issue #765: the previous hardcoded catalog silently omitted newly registered
 * tools such as gossip_ask, gossip_relay_cross_review, gossip_resolve_findings,
 * and gossip_chat_reply — formerly named `reply`).
 */
process.env.GOSSIPCAT_MCP_NO_MAIN = '1';
// mcp-server-sdk.ts runs an argv shim at import time and exits on an
// unrecognised subcommand — jest's argv (the test path) would trip it.
process.argv = [process.argv[0], 'gossipcat'];

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../../apps/cli/src/mcp-server-sdk';

describe('gossip_tools listing (#765)', () => {
  let root: string;
  let prevCwd: string;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  const textOf = (r: any): string => (r.content || []).map((c: any) => c.text).join('\n');

  beforeAll(async () => {
    prevCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'gossip-tools-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    writeFileSync(
      join(root, '.gossip', 'config.json'),
      JSON.stringify({ main_agent: { provider: 'none', model: 'x' }, agents: {} }),
    );
    process.chdir(root);
    server = createMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'gossip-tools-test', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('matches listTools() and includes previously omitted tools', async () => {
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    const r: any = await client.callTool({ name: 'gossip_tools', arguments: {} });
    expect(r.isError).toBeFalsy();
    const body = textOf(r);
    expect(body).toMatch(new RegExp(`^Gossipcat Tools \\(${listed.length}\\):`));

    const named = [...body.matchAll(/^- (gossip_[a-z0-9_]+):/gm)].map((m) => m[1]).sort();
    expect(named).toEqual(listed);

    for (const required of [
      'gossip_ask',
      'gossip_relay_cross_review',
      'gossip_resolve_findings',
      'gossip_chat_reply',
      'gossip_codex_bridge',
      'gossip_tools',
    ]) {
      expect(named).toContain(required);
    }
    // Old short name must stay gone (renamed to gossip_chat_reply).
    expect(named).not.toContain('reply');
  });
});
