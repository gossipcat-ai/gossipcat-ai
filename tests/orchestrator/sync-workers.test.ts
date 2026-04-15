/**
 * syncWorkers — keychain-diff short-circuit.
 *
 * The previous implementation unconditionally tore down every relay worker
 * on every syncWorkers call. Since syncWorkersViaKeychain runs on every
 * dispatch handler (gossip_dispatch, gossip_run, gossip_dispatch_consensus),
 * this produced a 4-worker RELAY DISCONNECTED burst per dispatch and
 * cancelled any in-flight RPC calls.
 *
 * These tests assert that:
 *   1. First call creates N workers, returns added == N.
 *   2. Second call with identical keychain state returns 0 and leaves the
 *      worker instances untouched (no stop/start).
 *   3. A single agent whose key changed is the only one rebuilt.
 */

import { MainAgent, ILLMProvider } from '@gossip/orchestrator';

// Mock WorkerAgent so start()/stop() don't touch a real relay. Each instance
// records its lifecycle so the tests can assert that non-rebuilt workers are
// never stopped.
jest.mock('../../packages/orchestrator/src/worker-agent', () => {
  let idCounter = 0;
  class FakeWorkerAgent {
    public readonly instanceId = ++idCounter;
    public startCalls = 0;
    public stopCalls = 0;
    constructor(public readonly agentId: string) {}
    async start() { this.startCalls++; }
    async stop() { this.stopCalls++; }
  }
  return { WorkerAgent: FakeWorkerAgent };
});

// Silence the ALL_TOOLS side effects — not needed for these tests.
jest.mock('@gossip/tools', () => ({ ALL_TOOLS: [] }), { virtual: false });

const mockLLM: ILLMProvider = {
  async generate() { return { text: '' }; },
};

function makeMainAgent() {
  return new MainAgent({
    provider: 'local',
    model: 'mock',
    relayUrl: 'ws://localhost:0',
    agents: [
      { id: 'alpha', provider: 'openai', model: 'gpt', skills: [] },
      { id: 'beta', provider: 'anthropic', model: 'claude', skills: [] },
      { id: 'gamma-native', provider: 'anthropic', model: 'sonnet', skills: [], native: true },
    ],
    llm: mockLLM,
  });
}

describe('MainAgent.syncWorkers — keychain short-circuit', () => {
  it('first call creates one worker per non-native agent', async () => {
    const agent = makeMainAgent();
    const keyProvider = jest.fn(async (provider: string) => `key-for-${provider}`);

    const added = await agent.syncWorkers(keyProvider);

    expect(added).toBe(2); // alpha + beta, gamma-native is skipped
    const alphaWorker = agent.getWorker('alpha') as any;
    const betaWorker = agent.getWorker('beta') as any;
    expect(alphaWorker).toBeDefined();
    expect(betaWorker).toBeDefined();
    expect(alphaWorker.startCalls).toBe(1);
    expect(betaWorker.startCalls).toBe(1);
    expect(alphaWorker.stopCalls).toBe(0);
    expect(betaWorker.stopCalls).toBe(0);
    expect(agent.getWorker('gamma-native' as any)).toBeUndefined();
  });

  it('second call with identical keychain state is a full no-op', async () => {
    const agent = makeMainAgent();
    const keyProvider = jest.fn(async (provider: string) => `key-for-${provider}`);

    await agent.syncWorkers(keyProvider);
    const alphaBefore = agent.getWorker('alpha') as any;
    const betaBefore = agent.getWorker('beta') as any;

    const addedSecond = await agent.syncWorkers(keyProvider);

    expect(addedSecond).toBe(0);
    const alphaAfter = agent.getWorker('alpha') as any;
    const betaAfter = agent.getWorker('beta') as any;

    // SAME instance references — no teardown/rebuild.
    expect(alphaAfter).toBe(alphaBefore);
    expect(betaAfter).toBe(betaBefore);
    expect(alphaAfter.startCalls).toBe(1);
    expect(betaAfter.startCalls).toBe(1);
    expect(alphaAfter.stopCalls).toBe(0);
    expect(betaAfter.stopCalls).toBe(0);
  });

  it('rebuilds only the agent whose provider key changed', async () => {
    const agent = makeMainAgent();

    let alphaKey = 'alpha-key-v1';
    const betaKey = 'beta-key-stable';
    const keyProvider = jest.fn(async (provider: string) => {
      if (provider === 'openai') return alphaKey;
      if (provider === 'anthropic') return betaKey;
      return null;
    });

    await agent.syncWorkers(keyProvider);
    const alphaBefore = agent.getWorker('alpha') as any;
    const betaBefore = agent.getWorker('beta') as any;

    // Rotate alpha's key only.
    alphaKey = 'alpha-key-v2';
    const added = await agent.syncWorkers(keyProvider);

    expect(added).toBe(1); // only alpha was rebuilt
    const alphaAfter = agent.getWorker('alpha') as any;
    const betaAfter = agent.getWorker('beta') as any;

    // Alpha rebuilt: old instance was stopped, new instance is different.
    expect(alphaBefore.stopCalls).toBe(1);
    expect(alphaAfter).not.toBe(alphaBefore);
    expect(alphaAfter.startCalls).toBe(1);

    // Beta untouched.
    expect(betaAfter).toBe(betaBefore);
    expect(betaAfter.stopCalls).toBe(0);
    expect(betaAfter.startCalls).toBe(1);
  });

  it('treats null==null key as a match (missing keychain entry does not churn workers)', async () => {
    const agent = makeMainAgent();
    const keyProvider = jest.fn(async () => null);

    await agent.syncWorkers(keyProvider);
    const alphaBefore = agent.getWorker('alpha') as any;

    const addedSecond = await agent.syncWorkers(keyProvider);

    expect(addedSecond).toBe(0);
    const alphaAfter = agent.getWorker('alpha') as any;
    expect(alphaAfter).toBe(alphaBefore);
    expect(alphaAfter.stopCalls).toBe(0);
  });
});
