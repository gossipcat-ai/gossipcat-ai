import { DispatchPipeline } from '@gossip/orchestrator';
import type { CollectResult } from '@gossip/orchestrator';

function mockWorker(result = 'done') {
  return {
    executeTask: jest.fn().mockResolvedValue({ result, inputTokens: 0, outputTokens: 0 }),
    subscribeToBatch: jest.fn().mockResolvedValue(undefined),
    unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DispatchPipeline consensus integration', () => {
  it('collect() returns CollectResult shape', async () => {
    const workers = new Map([['agent-a', mockWorker('## Consensus Summary\n- Bug A')]]);
    const pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-consensus-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });

    const { taskId } = pipeline.dispatch('agent-a', 'review code');
    const result: CollectResult = await pipeline.collect([taskId]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('completed');
    expect(result.consensus).toBeUndefined();
  });

  it('collect() with consensus: true runs consensus engine', async () => {
    const workerA = mockWorker('## Consensus Summary\n- SQL injection at auth.ts:47');
    const workerB = mockWorker('## Consensus Summary\n- Missing validation');

    const mockLlm = {
      generate: jest.fn().mockResolvedValue({
        text: JSON.stringify([
          { action: 'agree', agentId: 'agent-a', finding: 'SQL injection', evidence: 'confirmed', confidence: 5 },
        ]),
      }),
    };

    const workers = new Map([['agent-a', workerA], ['agent-b', workerB]]);
    const pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-consensus-test-' + Date.now(),
      workers,
      registryGet: (id) => ({
        id, provider: 'google' as const, model: 'gemini-2.0-flash',
        preset: id === 'agent-a' ? 'reviewer' : 'tester', skills: [],
      }),
      llm: mockLlm as any,
    });

    const { taskIds } = await pipeline.dispatchParallel([
      { agentId: 'agent-a', task: 'review code' },
      { agentId: 'agent-b', task: 'review code' },
    ]);

    const result = await pipeline.collect(taskIds, 120_000, { consensus: true });
    expect(result.consensus).toBeDefined();
    expect(result.consensus!.agentCount).toBe(2);
    expect(result.consensus!.summary).toContain('CONSENSUS REPORT');
  });

  it('collect() still returns results when consensus engine throws', async () => {
    const workerA = mockWorker('## Consensus Summary\n- Finding A');
    const workerB = mockWorker('## Consensus Summary\n- Finding B');

    // First two calls are for session gossip summarization (fire-and-forget),
    // then the consensus engine calls generate — make that one throw
    let callCount = 0;
    const mockLlm = {
      generate: jest.fn().mockImplementation(() => {
        callCount++;
        // Session gossip calls come first — let them succeed
        if (callCount <= 2) return Promise.resolve({ text: 'summary' });
        // Consensus cross-review call — throw
        return Promise.reject(new Error('LLM provider down'));
      }),
    };

    const workers = new Map([['agent-a', workerA], ['agent-b', workerB]]);
    const pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-consensus-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'google' as const, model: 'gemini-2.0-flash', skills: [] }),
      llm: mockLlm as any,
    });

    const { taskIds } = await pipeline.dispatchParallel([
      { agentId: 'agent-a', task: 'review code' },
      { agentId: 'agent-b', task: 'review code' },
    ]);

    const result = await pipeline.collect(taskIds, 120_000, { consensus: true });
    expect(result.results).toHaveLength(2);
    // Consensus engine catches cross-review errors gracefully and still produces a report
    // with unique findings — so consensus may still be defined. The key invariant is that
    // results are always returned regardless of consensus outcome.
    expect(result.results[0].status).toBe('completed');
    expect(result.results[1].status).toBe('completed');
  });

  it('collect() skips consensus when only one agent succeeds', async () => {
    const workerA = mockWorker('## Consensus Summary\n- Finding A');
    const workerB = { executeTask: jest.fn().mockRejectedValue(new Error('fail')), subscribeToBatch: jest.fn().mockResolvedValue(undefined), unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined) };

    // Track which calls are for consensus vs session gossip
    const consensusCalls: any[] = [];
    const mockLlm = {
      generate: jest.fn().mockImplementation((messages: any[]) => {
        // Session gossip summarization uses a system prompt starting with "Summarize"
        const isSessionGossip = messages[0]?.content?.startsWith('Summarize');
        if (!isSessionGossip) {
          consensusCalls.push(messages);
        }
        return Promise.resolve({ text: 'summary' });
      }),
    };

    const workers = new Map<string, any>([['agent-a', workerA], ['agent-b', workerB]]);
    const pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-consensus-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'google' as const, model: 'gemini-2.0-flash', skills: [] }),
      llm: mockLlm as any,
    });

    const { taskIds } = await pipeline.dispatchParallel([
      { agentId: 'agent-a', task: 'review code' },
      { agentId: 'agent-b', task: 'review code' },
    ]);

    const result = await pipeline.collect(taskIds, 120_000, { consensus: true });
    expect(result.consensus).toBeUndefined();
    // Only session gossip calls should have been made, no consensus calls
    expect(consensusCalls).toHaveLength(0);
  });

  it('collect() without consensus: true returns undefined consensus', async () => {
    const workers = new Map([
      ['agent-a', mockWorker('result A')],
      ['agent-b', mockWorker('result B')],
    ]);
    const pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-consensus-test-' + Date.now(),
      workers,
      registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });

    const { taskIds } = await pipeline.dispatchParallel([
      { agentId: 'agent-a', task: 'review code' },
      { agentId: 'agent-b', task: 'review code' },
    ]);

    const result = await pipeline.collect(taskIds);
    expect(result.consensus).toBeUndefined();
  });
});
