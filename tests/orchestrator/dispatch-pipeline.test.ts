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
});
