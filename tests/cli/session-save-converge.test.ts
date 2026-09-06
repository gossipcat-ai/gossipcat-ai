/**
 * Regression tests for GH #745 — `gossip_session_save` does not converge.
 *
 * Reported failure mode (maintainer, 4 consecutive attempts in one session):
 *
 *   gossip_session_save()                    → "Dispatching native utility…" [A]
 *   gossip_relay(task_id: A, result: …)      → "relay: _utility [A] completed"
 *   gossip_session_save(…)                   → "Dispatching native utility…" [B]   ← should have saved
 *   gossip_relay(task_id: B, result: …)      → "relay: _utility [B] completed"
 *   gossip_session_save(…)                   → "Dispatching native utility…" [C]   ← …forever
 *
 * Root cause: finalization was reachable ONLY through the `_utility_task_id`
 * re-entry argument. Once the summarizer was relayed, its task left
 * `ctx.nativeTaskMap`, so the refuse-gate no longer blocked; a save call that
 * omitted the id then ignored both the stashed session data and the relayed
 * summarizer output and minted a brand-new utility task. Nothing on the server
 * remembered that a summarizer for this save had already run, so the cycle had
 * no terminal state.
 *
 * Fix: `resolveSessionSummaryReentry` gives the handler its own record of the
 * in-flight save. A save call without `_utility_task_id` adopts a completed,
 * relayed-but-unconsumed session_summary result instead of re-dispatching.
 *
 * Suite layout:
 *   1. unit tests over the pure resolver;
 *   2. an end-to-end MCP-protocol test that replays the exact reported
 *      sequence through the real tool registrations.
 */
process.env.GOSSIPCAT_MCP_NO_MAIN = '1';
// mcp-server-sdk.ts runs an argv shim at import time and process.exit(2)s on an
// unrecognised subcommand — jest's argv (the test path) would trip it.
process.argv = [process.argv[0], 'gossipcat'];

import { createServer as createNetServer, type Server as NetServer } from 'net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { resolveSessionSummaryReentry } from '../../apps/cli/src/handlers/session-save-reentry';
import { createMcpServer } from '../../apps/cli/src/mcp-server-sdk';
import { ctx } from '../../apps/cli/src/mcp-context';

describe('resolveSessionSummaryReentry', () => {
  const completed = (completedAt: number) => ({ status: 'completed', result: '## Summary\n\nok', completedAt });

  it('adopts a relayed, unconsumed session_summary result', () => {
    const r = resolveSessionSummaryReentry({
      pendingTaskIds: ['aaaa1111'],
      getResult: (id) => (id === 'aaaa1111' ? completed(10) : undefined),
      hasPendingTask: () => false,
    });
    expect(r.adoptTaskId).toBe('aaaa1111');
    expect(r.inFlightTaskId).toBeUndefined();
  });

  it('adopts the most recently completed candidate when several are stashed', () => {
    const results: Record<string, ReturnType<typeof completed>> = {
      older: completed(100),
      newer: completed(500),
    };
    const r = resolveSessionSummaryReentry({
      pendingTaskIds: ['older', 'newer'],
      getResult: (id) => results[id],
      hasPendingTask: () => false,
    });
    expect(r.adoptTaskId).toBe('newer');
  });

  it('does not adopt a completed result with empty output', () => {
    const r = resolveSessionSummaryReentry({
      pendingTaskIds: ['aaaa1111'],
      getResult: () => ({ status: 'completed', result: '', completedAt: 10 }),
      hasPendingTask: () => false,
    });
    expect(r.adoptTaskId).toBeUndefined();
  });

  it('does not adopt a failed or timed-out summarizer', () => {
    for (const status of ['failed', 'timed_out', 'superseded']) {
      const r = resolveSessionSummaryReentry({
        pendingTaskIds: ['aaaa1111'],
        getResult: () => ({ status, result: 'partial', completedAt: 10 }),
        hasPendingTask: () => false,
      });
      expect(r.adoptTaskId).toBeUndefined();
    }
  });

  it('reports a still-armed dispatch as in-flight, never as adoptable', () => {
    const r = resolveSessionSummaryReentry({
      pendingTaskIds: ['aaaa1111'],
      getResult: () => undefined,
      hasPendingTask: (id) => id === 'aaaa1111',
    });
    expect(r.adoptTaskId).toBeUndefined();
    expect(r.inFlightTaskId).toBe('aaaa1111');
  });

  it('ignores a stash whose task is gone and has no result (evicted)', () => {
    const r = resolveSessionSummaryReentry({
      pendingTaskIds: ['aaaa1111'],
      getResult: () => undefined,
      hasPendingTask: () => false,
    });
    expect(r).toEqual({});
  });

  it('returns nothing when no save is in flight', () => {
    const r = resolveSessionSummaryReentry({
      pendingTaskIds: [],
      getResult: () => undefined,
      hasPendingTask: () => false,
    });
    expect(r).toEqual({});
  });
});

describe('gossip_session_save converges over the real MCP tool (#745)', () => {
  let tmp: string;
  let origCwd: string;
  let origHttpPort: string | undefined;
  let portBlocker: NetServer;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  const textOf = (r: any): string => (r.content || []).map((c: any) => c.text).join('\n');
  const taskIdOf = (text: string): string | undefined => /_utility_task_id: "([0-9a-f]+)"/.exec(text)?.[1];
  const save = (args: Record<string, unknown> = {}) =>
    client.callTool({ name: 'gossip_session_save', arguments: args });

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ss745-'));
    origCwd = process.cwd();
    mkdirSync(join(tmp, '.gossip'), { recursive: true });
    // utility_model.provider = 'native' is what puts the handler on the
    // Agent()-dispatch path this bug lives on.
    writeFileSync(
      join(tmp, '.gossip', 'config.json'),
      JSON.stringify({
        main_agent: { provider: 'none', model: 'none' },
        utility_model: { provider: 'native', model: 'sonnet' },
        agents: {},
      }),
    );
    process.chdir(tmp);

    // boot() also starts an HTTP MCP transport whose server handle is not
    // exported, which would keep jest's event loop open. Occupying its port
    // makes listen() fail with EADDRINUSE, which boot already handles by
    // skipping the transport — no stray handle, no --forceExit needed.
    portBlocker = createNetServer();
    await new Promise<void>((resolve) => portBlocker.listen(0, '127.0.0.1', resolve));
    origHttpPort = process.env.GOSSIPCAT_HTTP_PORT;
    process.env.GOSSIPCAT_HTTP_PORT = String((portBlocker.address() as { port: number }).port);

    server = createMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'session-save-converge-test', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    // Disconnect relay clients BEFORE stopping the relay, otherwise their
    // reconnect timers spin for the rest of the run.
    try { await (ctx.mainAgent as any)?.orchestratorAgent?.disconnect?.(); } catch { /* best-effort */ }
    try { await ctx.relay?.stop(); } catch { /* best-effort */ }
    if (origHttpPort === undefined) delete process.env.GOSSIPCAT_HTTP_PORT;
    else process.env.GOSSIPCAT_HTTP_PORT = origHttpPort;
    await new Promise<void>((resolve) => portBlocker.close(() => resolve()));
    process.chdir(origCwd);
    rmSync(tmp, { recursive: true, force: true });
  }, 60000);

  it('advertises _utility_task_id on the tool schema', async () => {
    const tools = await client.listTools();
    const schema: any = tools.tools.find((t) => t.name === 'gossip_session_save')?.inputSchema;
    expect(schema?.properties?._utility_task_id).toBeDefined();
  });

  it('finalizes when the re-call carries _utility_task_id (unchanged happy path)', async () => {
    const dispatch = textOf(await save());
    expect(dispatch).toContain('Dispatching native utility for summary');
    const taskId = taskIdOf(dispatch);
    expect(taskId).toBeDefined();

    await client.callTool({
      name: 'gossip_relay',
      arguments: { task_id: taskId, result: '## Summary\n\nExplicit re-entry path.\n' },
    });

    const saved = textOf(await save({ notes: '', _utility_task_id: taskId }));
    expect(saved).toContain('Session saved.');
    expect(saved).not.toContain('Dispatching native utility');
    // Explicit re-entry must not advertise the adoption fallback.
    expect(saved).not.toContain('adopted relayed summary');
    expect(saved).toContain('Explicit re-entry path.');
  }, 60000);

  it('converges when the re-call DROPS _utility_task_id — the #745 loop', async () => {
    const dispatch = textOf(await save());
    expect(dispatch).toContain('Dispatching native utility for summary');
    const taskId = taskIdOf(dispatch);
    expect(taskId).toBeDefined();

    const relayed = textOf(
      await client.callTool({
        name: 'gossip_relay',
        arguments: { task_id: taskId, result: '## Summary\n\nRelayed but id dropped.\n' },
      }),
    );
    expect(relayed).toContain(`relay: _utility [${taskId}] completed`);

    // Before the fix this returned "Session data gathered. Dispatching native
    // utility for summary." plus a brand-new task_id, and did so on every
    // subsequent call — the reported non-convergence.
    const saved = textOf(await save());
    expect(saved).toContain('Session saved.');
    expect(saved).not.toContain('Dispatching native utility');
    expect(saved).toContain(`adopted relayed summary [${taskId}]`);
    // The adopted content is the relayed summarizer output, not a re-run.
    expect(saved).toContain('Relayed but id dropped.');
  }, 60000);

  it('still dispatches a fresh summarizer once the previous save was consumed', async () => {
    // Nothing outstanding after the previous test consumed its stash — a new
    // save must start a new summarizer rather than re-adopting stale output.
    const dispatch = textOf(await save());
    expect(dispatch).toContain('Dispatching native utility for summary');
    expect(taskIdOf(dispatch)).toBeDefined();
    // Drain it so the suite leaves no armed utility task behind.
    await client.callTool({
      name: 'gossip_relay',
      arguments: { task_id: taskIdOf(dispatch), result: '## Summary\n\nDrain.\n' },
    });
    expect(textOf(await save())).toContain('Session saved.');
  }, 60000);
});
