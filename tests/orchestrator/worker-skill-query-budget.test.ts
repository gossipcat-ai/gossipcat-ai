import { jest } from '@jest/globals';
const vi = jest;

// Mock GossipAgent so constructing a WorkerAgent never opens a relay socket.
vi.mock('@gossip/client', () => ({
  GossipAgent: class {
    async connect() {}
    async disconnect() {}
    on() {}
    async sendEnvelope() {}
  },
}));

import { WorkerAgent } from '../../packages/orchestrator/src/worker-agent';
import { ALL_TOOLS } from '../../packages/tools/src/definitions';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';

const stubLlm = {
  async generate() { return { text: '', inputTokens: 0, outputTokens: 0 }; },
} as unknown as ILLMProvider;

describe('skill_query per-task call budget (issue #715)', () => {
  it('is registered in ALL_TOOLS with a single required `skill` arg', () => {
    const def = ALL_TOOLS.find(t => t.name === 'skill_query');
    expect(def).toBeDefined();
    expect(def!.parameters.required).toEqual(['skill']);
    expect(Object.keys(def!.parameters.properties)).toEqual(['skill']);
  });

  it('rejects the third call in a task and points the agent at conversation history', async () => {
    const worker = new WorkerAgent('agent-a', stubLlm, 'ws://localhost:0', ALL_TOOLS);
    const callTool = (worker as any).callTool.bind(worker);

    // The first two calls are within budget: they dispatch an RPC that never
    // resolves against the stub relay, so they are intentionally not awaited.
    const inFlight = [
      callTool('skill_query', { skill: 'one' }),
      callTool('skill_query', { skill: 'two' }),
    ];
    inFlight.forEach(p => p.catch(() => {}));

    const third = await callTool('skill_query', { skill: 'three' });
    expect(third).toContain('skill_query per-task budget exhausted (2 calls)');
    expect(third).toContain('conversation history');
  });

  it('resets the budget between tasks so a second executeTask starts fresh (f3)', async () => {
    // executeTask is an async generator; a stub LLM that returns no tool calls
    // finishes it in one turn without touching the relay.
    const oneTurnLlm = {
      async generate() { return { text: 'done', inputTokens: 0, outputTokens: 0 }; },
    } as unknown as ILLMProvider;
    const worker = new WorkerAgent('agent-a', oneTurnLlm, 'ws://localhost:0', ALL_TOOLS);
    const callTool = (worker as any).callTool.bind(worker);

    const drain = async () => { for await (const _ of worker.executeTask('task text')) { /* consume */ } };

    // Task 1: burn the budget, confirm exhaustion.
    await drain();
    [callTool('skill_query', { skill: 'one' }), callTool('skill_query', { skill: 'two' })]
      .forEach(p => p.catch(() => {}));
    expect(await callTool('skill_query', { skill: 'three' })).toContain('budget exhausted');
    expect((worker as any).toolCallBudget.get('skill_query')).toBe(2);

    // Task 2: executeTask must clear the per-tool counters.
    await drain();
    expect((worker as any).toolCallBudget.get('skill_query')).toBeUndefined();

    // ...and a call in the new task is admitted rather than rejected.
    const fresh = callTool('skill_query', { skill: 'four' });
    fresh.catch(() => {});
    await expect(Promise.race([fresh, Promise.resolve('pending')])).resolves.toBe('pending');
  });

  it('budgets each tool independently — memory_query is unaffected by skill_query usage', async () => {
    const worker = new WorkerAgent('agent-a', stubLlm, 'ws://localhost:0', ALL_TOOLS);
    const callTool = (worker as any).callTool.bind(worker);

    [
      callTool('skill_query', { skill: 'one' }),
      callTool('skill_query', { skill: 'two' }),
      callTool('memory_query', { query: 'anything' }),
    ].forEach(p => p.catch(() => {}));

    const skillThird = await callTool('skill_query', { skill: 'three' });
    expect(skillThird).toContain('budget exhausted');

    // memory_query has its own (larger) cap and must still be callable.
    const memSecond = callTool('memory_query', { query: 'still allowed' });
    memSecond.catch(() => {});
    await expect(Promise.race([memSecond, Promise.resolve('pending')])).resolves.toBe('pending');
  });
});
