/**
 * MainAgent.start() — the MCP-boot worker path (issue #522).
 *
 * start() is the SECOND key-resolution site (alongside syncWorkers). Before
 * #522 it resolved keyProviderFn(config.provider), built via raw
 * createProvider(...) — which dropped base_url and bypassed the DegradedProvider
 * pre-flight — and cached the provider-resolved key in lastKeyByAgent (forcing a
 * spurious first-syncWorkers teardown).
 *
 * These tests assert the post-#522 behavior at the boot path:
 *   1. Key is resolved from the per-agent keychain SERVICE (key_ref ?? provider).
 *   2. The worker is built via createProviderForAgent, so a missing key yields a
 *      DegradedProvider (pre-flight) rather than a live empty-Bearer provider.
 *   3. base_url is honored on the boot path (no longer dropped).
 *   4. key_ref + base_url are orthogonal (different fields, both respected).
 */

// Capture the llm handed to each WorkerAgent so we can probe its behavior.
const builtWorkers: Array<{ agentId: string; llm: any }> = [];
jest.mock('../../packages/orchestrator/src/worker-agent', () => {
  class FakeWorkerAgent {
    constructor(public readonly agentId: string, public readonly llm: any) {
      builtWorkers.push({ agentId, llm });
    }
    async start() { /* no relay */ }
    async stop() { /* no relay */ }
  }
  return { WorkerAgent: FakeWorkerAgent };
});

// Stub the relay client so start()'s orchestrator connection is a no-op.
jest.mock('@gossip/client', () => ({
  GossipAgent: class {
    on() { /* noop */ }
    async connect() { /* noop */ }
  },
}));

jest.mock('@gossip/tools', () => ({ ALL_TOOLS: [] }), { virtual: false });

import { MainAgent, ILLMProvider } from '@gossip/orchestrator';

const mockLLM: ILLMProvider = { async generate() { return { text: '' }; } };

function workerFor(id: string) {
  const w = builtWorkers.find(b => b.agentId === id);
  if (!w) throw new Error(`worker ${id} not built`);
  return w;
}

beforeEach(() => { builtWorkers.length = 0; });

describe('MainAgent.start() — key_ref + base_url on the MCP-boot path (#522)', () => {
  it('resolves the boot key from the per-agent service (key_ref ?? provider)', async () => {
    const keyProvider = jest.fn(async (service: string) => `key-for-${service}`);
    const agent = new MainAgent({
      provider: 'local', model: 'mock', relayUrl: 'ws://localhost:0',
      keyProvider,
      agents: [
        { id: 'a-ref', provider: 'openai', model: 'gpt', skills: [], key_ref: 'shared-key' },
        { id: 'b-noref', provider: 'anthropic', model: 'claude', skills: [] },
      ],
      llm: mockLLM,
    });

    await agent.start();

    const services = keyProvider.mock.calls.map(c => c[0]);
    expect(services).toContain('shared-key'); // a-ref → key_ref
    expect(services).toContain('anthropic');  // b-noref → provider
    expect(services).not.toContain('openai'); // never the provider when key_ref is set
  });

  it('builds via createProviderForAgent: a missing key yields a DegradedProvider naming the key_ref service + base_url', async () => {
    // No key in the keychain → pre-flight should degrade.
    const keyProvider = jest.fn(async () => null);
    const agent = new MainAgent({
      provider: 'local', model: 'mock', relayUrl: 'ws://localhost:0',
      keyProvider,
      agents: [
        { id: 'ds', provider: 'deepseek', model: 'deepseek-chat', skills: [], key_ref: 'deepseek', base_url: 'https://api.deepseek.com/v1' },
      ],
      llm: mockLLM,
    });

    await agent.start();

    const { llm } = workerFor('ds');
    // The DegradedProvider fails the task with a clear, key_ref-naming message —
    // proving createProviderForAgent (not raw createProvider) was used on boot.
    let caught: Error | undefined;
    try { await llm.generate([{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('no API key configured for agent "ds"');
    expect(caught!.message).toContain('keychain service "deepseek"');
    // base_url is honored on the boot path (no longer dropped).
    expect(caught!.message).toContain('https://api.deepseek.com/v1');
  });

  it('orthogonality: key_ref names the key service while base_url targets a different endpoint', async () => {
    const keyProvider = jest.fn(async (service: string) =>
      service === 'my-custom-key' ? 'sk-real-custom' : null,
    );
    const agent = new MainAgent({
      provider: 'local', model: 'mock', relayUrl: 'ws://localhost:0',
      keyProvider,
      agents: [
        { id: 'ortho', provider: 'openai', model: 'gpt-4', skills: [], key_ref: 'my-custom-key', base_url: 'https://api.example.com/v1' },
      ],
      llm: mockLLM,
    });

    await agent.start();

    // The key was resolved from the custom service, NOT 'openai'.
    expect(keyProvider).toHaveBeenCalledWith('my-custom-key');
    expect(keyProvider).not.toHaveBeenCalledWith('openai');

    // With a real key present, a live (non-degraded) provider is built. Drive a
    // 401 to confirm it targets the base_url, proving the two fields are independent.
    const { llm } = workerFor('ortho');
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad' }) as unknown as typeof fetch;
    let caught: Error | undefined;
    try { await llm.generate([{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
    global.fetch = originalFetch;
    expect(caught!.message).toContain('https://api.example.com/v1');
    expect(caught!.message).not.toContain('api.openai.com');
  });
});
