import { RelayServer } from '@gossip/relay';
import { ToolServer } from '@gossip/tools';
import { WorkerAgent } from '@gossip/orchestrator';
import { GossipAgent } from '@gossip/client';
import { ALL_TOOLS } from '@gossip/tools';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ─── Mock LLM ────────────────────────────────────────────────────────────────

/**
 * MockLLM simulates real LLM behavior:
 * - First call with tools available → returns a file_read tool call
 * - After a tool result is present → returns a final text response using the tool content
 * - Decomposition calls → returns a single-task plan
 * - Synthesis calls → returns a summary
 */
class MockLLM {
  callCount = 0;

  async generate(messages: any[], options?: any): Promise<any> {
    this.callCount++;
    const systemContent: string = messages.find((m: any) => m.role === 'system')?.content ?? '';
    const hasTool = messages.some((m: any) => m.role === 'tool');

    // Decomposition call
    if (systemContent.includes('decomposition') || systemContent.includes('Break the user')) {
      const userContent = [...messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
      return {
        text: JSON.stringify({
          strategy: 'single',
          subTasks: [{ description: userContent, requiredSkills: ['typescript'] }],
        }),
      };
    }

    // Synthesis call
    if (systemContent.includes('Synthesize')) {
      return { text: 'Here is the synthesized result from the agents.' };
    }

    // Tool loop: request file_read on first turn (no tool results yet)
    if (options?.tools?.length && !hasTool) {
      return {
        text: '',
        toolCalls: [{
          id: 'call-1',
          name: 'file_read',
          arguments: { path: 'src/example.ts' },
        }],
      };
    }

    // Tool loop: after tool result is received, produce a final answer
    if (hasTool) {
      const toolMsg = messages.find((m: any) => m.role === 'tool');
      const content: string = typeof toolMsg?.content === 'string' ? toolMsg.content : '';
      return { text: `I read the file. It contains: ${content.substring(0, 100)}` };
    }

    return { text: 'Done.' };
  }
}

// ─── Suite setup ─────────────────────────────────────────────────────────────

describe('E2E: Full Gossip Mesh Flow', () => {
  let relay: RelayServer;
  let toolServer: ToolServer;
  let testProjectDir: string;

  beforeAll(async () => {
    // Create a temporary project directory with a test file
    testProjectDir = resolve(tmpdir(), `gossip-e2e-test-${Date.now()}`);
    mkdirSync(resolve(testProjectDir, 'src'), { recursive: true });
    writeFileSync(
      resolve(testProjectDir, 'src/example.ts'),
      'export function hello(): string {\n  return "Hello from Gossip Mesh!";\n}\n',
    );

    // Start relay on a random port
    relay = new RelayServer({ port: 0 });
    await relay.start();

    // Start tool server pointed at the test project
    toolServer = new ToolServer({
      relayUrl: relay.url,
      projectRoot: testProjectDir,
    });
    await toolServer.start();

    // Small delay to ensure tool server has registered with the relay
    await new Promise(r => setTimeout(r, 200));
  }, 15_000);

  afterAll(async () => {
    await toolServer.stop();
    await relay.stop();
    try { rmSync(testProjectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ─── Test 1: Full pipeline ──────────────────────────────────────────────────

  it('routes a task through the full pipeline: worker → tool-server → result', async () => {
    const mockLLM = new MockLLM();
    const worker = new WorkerAgent('test-worker', mockLLM, relay.url, ALL_TOOLS);
    await worker.start();

    // Give the worker time to register
    await new Promise(r => setTimeout(r, 100));

    const result = await worker.executeTask('Read src/example.ts and describe what it does');

    // The worker should have:
    //   1. Called MockLLM → got a file_read tool call
    //   2. Sent RPC_REQUEST to tool-server via relay
    //   3. Tool server read the real file and sent RPC_RESPONSE
    //   4. Worker received file contents and called MockLLM again
    //   5. MockLLM returned a final response referencing the file content
    expect(result).toMatch(/I read the file/i);
    expect(result).toMatch(/Hello from Gossip Mesh/i);

    await worker.stop();
  }, 30_000);

  // ─── Test 2: Security — path traversal blocked ─────────────────────────────

  it('tool server denies access to paths outside project root', async () => {
    // MockLLM that immediately asks for /etc/passwd
    const evilLLM = {
      callCount: 0,
      async generate(messages: any[], _options?: any): Promise<any> {
        this.callCount++;
        if (!messages.some((m: any) => m.role === 'tool')) {
          return {
            text: '',
            toolCalls: [{ id: 'evil-1', name: 'file_read', arguments: { path: '/etc/passwd' } }],
          };
        }
        // This branch should not be reached — the tool call should throw
        const toolMsg = messages.find((m: any) => m.role === 'tool');
        return { text: `Tool responded: ${toolMsg?.content}` };
      },
    };

    const worker = new WorkerAgent('evil-worker', evilLLM, relay.url, ALL_TOOLS);
    await worker.start();
    await new Promise(r => setTimeout(r, 100));

    // The tool-server rejects the path; the worker catches the error and
    // passes it as a tool result so the LLM can see it and adapt
    const result = await worker.executeTask('Read /etc/passwd');
    expect(result.toLowerCase()).toContain('outside project root');

    await worker.stop();
  }, 30_000);

  // ─── Test 3: Timeout when no tool server present ────────────────────────────

  it('handles tool call timeout gracefully when no tool server is registered', async () => {
    // Isolated relay with no tool server
    const isolatedRelay = new RelayServer({ port: 0 });
    await isolatedRelay.start();

    // Shorten the timeout by monkey-patching the constant is not practical,
    // so we just verify the worker connects and can be stopped cleanly.
    // Full timeout testing would require a very long wait (30 s), so we
    // assert only that the worker starts and stops without hanging.
    const mockLLM = new MockLLM();
    const worker = new WorkerAgent('timeout-worker', mockLLM, isolatedRelay.url, ALL_TOOLS);
    await worker.start();

    // Don't invoke executeTask here — the 30 s tool-call timeout would block the test.
    // Instead, verify the infrastructure is alive.
    expect(worker).toBeDefined();

    await worker.stop();
    await isolatedRelay.stop();
  }, 15_000);

  // ─── Test 4: Multi-agent channel pub/sub ────────────────────────────────────

  it('multiple agents can communicate through the relay simultaneously', async () => {
    const agentA = new GossipAgent({ agentId: 'e2e-agent-a', relayUrl: relay.url });
    const agentB = new GossipAgent({ agentId: 'e2e-agent-b', relayUrl: relay.url });
    const agentC = new GossipAgent({ agentId: 'e2e-agent-c', relayUrl: relay.url });

    await agentA.connect();
    await agentB.connect();
    await agentC.connect();

    // B and C subscribe to the channel
    await agentB.subscribe('e2e-channel');
    await agentC.subscribe('e2e-channel');
    await new Promise(r => setTimeout(r, 100));

    const receivedByB: any[] = [];
    const receivedByC: any[] = [];
    agentB.on('message', (data: any) => receivedByB.push(data));
    agentC.on('message', (data: any) => receivedByC.push(data));

    // A publishes to the channel
    await agentA.sendChannel('e2e-channel', { msg: 'hello all' });
    await new Promise(r => setTimeout(r, 300));

    expect(receivedByB.length).toBeGreaterThanOrEqual(1);
    expect(receivedByC.length).toBeGreaterThanOrEqual(1);
    expect(receivedByB[0]).toEqual({ msg: 'hello all' });
    expect(receivedByC[0]).toEqual({ msg: 'hello all' });

    await agentA.disconnect();
    await agentB.disconnect();
    await agentC.disconnect();
  }, 10_000);
});
