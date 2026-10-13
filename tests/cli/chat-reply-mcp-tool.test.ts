/**
 * gossip_chat_reply (renamed from `reply`) through the real MCP registration:
 * it is listed with its argument schema, the old `reply` name is gone, and the
 * handler rejects a missing chat_id.
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

describe('gossip_chat_reply MCP tool', () => {
  let root: string;
  let prevCwd: string;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  const textOf = (r: any): string => (r.content || []).map((c: any) => c.text).join('\n');

  beforeAll(async () => {
    prevCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'chat-reply-mcp-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    writeFileSync(join(root, '.gossip', 'config.json'), JSON.stringify({ main_agent: { provider: 'none', model: 'x' }, agents: {} }));
    process.chdir(root);
    server = createMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'chat-reply-mcp-test', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('registers gossip_chat_reply with its schema; the old reply name is gone', async () => {
    const tools = (await client.listTools()).tools;
    const main = tools.find((t) => t.name === 'gossip_chat_reply');
    expect(main).toBeDefined();
    expect(Object.keys((main!.inputSchema as any).properties).sort()).toEqual(['chat_id', 'in_reply_to', 'text']);
    expect(tools.find((t) => t.name === 'reply')).toBeUndefined();
  });

  it('rejects a missing chat_id', async () => {
    const r: any = await client.callTool({ name: 'gossip_chat_reply', arguments: { chat_id: '', text: 'x' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('gossip_chat_reply error: chat_id is required.');
  });
});
