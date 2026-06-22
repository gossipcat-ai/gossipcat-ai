import { ConsensusCoordinator } from '@gossip/orchestrator/consensus-coordinator';

describe('ConsensusCoordinator', () => {
  it('instantiates with required dependencies', () => {
    const coordinator = new ConsensusCoordinator({
      llm: null,
      registryGet: () => undefined,
      projectRoot: '/tmp/test',
      keyProvider: null,
    });
    expect(coordinator).toBeDefined();
  });

  it('returns undefined when no LLM configured', async () => {
    const coordinator = new ConsensusCoordinator({
      llm: null,
      registryGet: () => undefined,
      projectRoot: '/tmp/test',
      keyProvider: null,
    });
    const result = await coordinator.runConsensus([]);
    expect(result).toBeUndefined();
  });

  it('returns undefined when fewer than 2 completed results', async () => {
    const coordinator = new ConsensusCoordinator({
      llm: { generate: async () => ({ text: '' }) } as any,
      registryGet: () => undefined,
      projectRoot: '/tmp/test',
      keyProvider: null,
    });
    const result = await coordinator.runConsensus([
      { id: 't1', agentId: 'a', task: 'review', status: 'completed', result: 'ok', startedAt: 0, completedAt: 1 },
    ]);
    expect(result).toBeUndefined();
  });

  it('tracks current phase', () => {
    const coordinator = new ConsensusCoordinator({
      llm: null, registryGet: () => undefined, projectRoot: '/tmp/test', keyProvider: null,
    });
    expect(coordinator.getCurrentPhase()).toBe('idle');
  });
});
