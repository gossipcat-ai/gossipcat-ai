/**
 * gossip_inbox_send through the real MCP tool registration: schema, success
 * text, and the isError mapping of handler rejections (incl. the length cap).
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
import { INBOX_SEND_MAX_CHARS } from '../../apps/cli/src/handlers/inbox-send';
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';

describe('gossip_inbox_send MCP tool', () => {
  let root: string;
  let prevCwd: string;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  const textOf = (r: any): string => (r.content || []).map((c: any) => c.text).join('\n');
  const send = (args: Record<string, unknown>) => client.callTool({ name: 'gossip_inbox_send', arguments: args });

  beforeAll(async () => {
    prevCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'inbox-send-mcp-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    writeFileSync(join(root, '.gossip', 'config.json'), JSON.stringify({
      main_agent: { provider: 'none', model: 'x' },
      agents: { 'codex-sol': { provider: 'openai', model: 'x' } },
    }));
    process.chdir(root);
    server = createMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'inbox-send-mcp-test', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('is registered with its argument schema', async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'gossip_inbox_send');
    expect(tool).toBeDefined();
    expect(Object.keys((tool!.inputSchema as any).properties).sort()).toEqual(['in_reply_to', 'kind', 'ref', 'text', 'to']);
  });

  it('queues mail for a configured agent and reports the id', async () => {
    const r: any = await send({ to: 'codex-sol', text: 'please re-run the suite' });
    expect(r.isError).toBeFalsy();
    const id = /Queued inbox message (\S+) for codex-sol/.exec(textOf(r))![1];
    expect(new ClaudeInbox(inboxDirFor(root)).get(id)).toMatchObject({ from: 'orchestrator', to: 'codex-sol', status: 'queued' });
  });

  it('maps handler rejections to isError (unknown agent, over-long text)', async () => {
    const unknown: any = await send({ to: 'ghost', text: 'x' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('gossip_inbox_send error: "to" must be a configured agent id');
    const long: any = await send({ to: 'codex-sol', text: 'x'.repeat(INBOX_SEND_MAX_CHARS + 1) });
    expect(long.isError).toBe(true);
    expect(textOf(long)).toContain(`at most ${INBOX_SEND_MAX_CHARS} chars`);
  });
});
