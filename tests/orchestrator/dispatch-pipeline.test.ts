import { DispatchPipeline } from '@gossip/orchestrator';

// Minimal mock worker
function mockWorker(result = 'done') {
  return {
    executeTask: jest.fn().mockResolvedValue(result),
    subscribeToBatch: jest.fn().mockResolvedValue(undefined),
    unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
  };
}

// Minimal mock registry entry
function mockRegistryGet(skills: string[] = ['testing']) {
  return { id: 'test-agent', provider: 'local' as const, model: 'mock', skills };
}

describe('DispatchPipeline', () => {
  let pipeline: DispatchPipeline;
  let workers: Map<string, ReturnType<typeof mockWorker>>;

  beforeEach(() => {
    workers = new Map([['test-agent', mockWorker()]]);
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-test-' + Date.now(),
      workers,
      registryGet: (id) => id === 'test-agent' ? mockRegistryGet() : undefined,
    });
  });

  describe('dispatch()', () => {
    it('dispatches to worker and returns taskId + promise', async () => {
      const { taskId, promise } = pipeline.dispatch('test-agent', 'review code');
      expect(taskId).toMatch(/^[a-f0-9]{8}$/);
      const result = await promise;
      expect(result).toBe('done');
      expect(workers.get('test-agent')!.executeTask).toHaveBeenCalledTimes(1);
    });

    it('throws for unknown agent', () => {
      expect(() => pipeline.dispatch('nope', 'task')).toThrow('Agent "nope" not found');
    });

    it('tracks task status after completion', async () => {
      const { taskId, promise } = pipeline.dispatch('test-agent', 'review code');
      await promise;
      const task = pipeline.getTask(taskId);
      expect(task?.status).toBe('completed');
      expect(task?.result).toBe('done');
    });

    it('tracks task status after failure', async () => {
      const failWorker = {
        executeTask: jest.fn().mockRejectedValue(new Error('boom')),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };
      workers.set('fail-agent', failWorker);
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => id === 'fail-agent'
          ? { id: 'fail-agent', provider: 'local' as const, model: 'mock', skills: [] }
          : undefined,
      });

      const { taskId, promise } = pipeline.dispatch('fail-agent', 'bad task');
      await promise.catch(() => {});
      const task = pipeline.getTask(taskId);
      expect(task?.status).toBe('failed');
      expect(task?.error).toBe('boom');
    });
  });

  describe('collect()', () => {
    it('waits for tasks and returns results', async () => {
      const { taskId } = pipeline.dispatch('test-agent', 'review code');
      const results = await pipeline.collect([taskId]);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('completed');
      expect(results[0].result).toBe('done');
    });

    it('collects all running tasks when no ids given', async () => {
      pipeline.dispatch('test-agent', 'task 1');
      pipeline.dispatch('test-agent', 'task 2');
      const results = await pipeline.collect();
      expect(results).toHaveLength(2);
    });

    it('returns empty array when no tasks match', async () => {
      const results = await pipeline.collect(['nonexistent']);
      expect(results).toHaveLength(0);
    });

    it('cleans up completed tasks after collect', async () => {
      const { taskId } = pipeline.dispatch('test-agent', 'review code');
      await pipeline.collect([taskId]);
      expect(pipeline.getTask(taskId)).toBeUndefined();
    });
  });

  describe('dispatchParallel()', () => {
    it('dispatches multiple tasks and returns ids', () => {
      workers.set('agent-b', mockWorker('result-b'));
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });

      const { taskIds, errors } = pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1' },
        { agentId: 'agent-b', task: 'task 2' },
      ]);
      expect(taskIds).toHaveLength(2);
      expect(errors).toHaveLength(0);
    });

    it('reports errors for missing agents', () => {
      const { taskIds, errors } = pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1' },
        { agentId: 'missing', task: 'task 2' },
      ]);
      expect(taskIds).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('missing');
    });
  });
});
