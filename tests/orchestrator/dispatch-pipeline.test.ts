import { DispatchPipeline } from '@gossip/orchestrator';

// Minimal mock worker
function mockWorker(result = 'done') {
  return {
    executeTask: jest.fn().mockResolvedValue({ result, inputTokens: 0, outputTokens: 0 }),
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

    it('detects orphaned tasks from server restart and returns failure entries', async () => {
      // Simulate: task was dispatched (recorded in TaskGraph) but pipeline restarted (Map is empty)
      const { TaskGraph } = require('@gossip/orchestrator');
      const taskGraph = new TaskGraph(pipeline['projectRoot']);
      taskGraph.recordCreated('orphan-1', 'test-agent', 'lost task', ['testing']);

      const results = await pipeline.collect(['orphan-1']);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('orphan-1');
      expect(results[0].status).toBe('failed');
      expect(results[0].error).toContain('server restarted');
    });

    it('cleans up completed tasks after collect', async () => {
      const { taskId } = pipeline.dispatch('test-agent', 'review code');
      await pipeline.collect([taskId]);
      expect(pipeline.getTask(taskId)).toBeUndefined();
    });
  });

  describe('write modes', () => {
    it('sequential mode queues tasks', async () => {
      const order: number[] = [];
      const slowWorker = {
        executeTask: jest.fn()
          .mockImplementationOnce(() => new Promise(r => setTimeout(() => { order.push(1); r({ result: 'first', inputTokens: 0, outputTokens: 0 }); }, 50)))
          .mockImplementationOnce(() => new Promise(r => setTimeout(() => { order.push(2); r({ result: 'second', inputTokens: 0, outputTokens: 0 }); }, 10))),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };
      workers.set('slow-agent', slowWorker);
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });

      const t1 = pipeline.dispatch('slow-agent', 'task 1', { writeMode: 'sequential' });
      const t2 = pipeline.dispatch('slow-agent', 'task 2', { writeMode: 'sequential' });
      await Promise.all([t1.promise, t2.promise]);
      expect(order).toEqual([1, 2]); // second waits for first
    });

    it('scoped mode rejects overlapping scope', () => {
      pipeline.dispatch('test-agent', 'task 1', { writeMode: 'scoped', scope: 'packages/relay/' });
      expect(() =>
        pipeline.dispatch('test-agent', 'task 2', { writeMode: 'scoped', scope: 'packages/relay/src/' })
      ).toThrow(/overlaps/);
    });

    it('scoped mode requires scope param', () => {
      expect(() =>
        pipeline.dispatch('test-agent', 'task 1', { writeMode: 'scoped' })
      ).toThrow('scoped write mode requires a scope path');
    });

    it('scoped mode allows non-overlapping scopes', () => {
      pipeline.dispatch('test-agent', 'task 1', { writeMode: 'scoped', scope: 'packages/relay/' });
      expect(() =>
        pipeline.dispatch('test-agent', 'task 2', { writeMode: 'scoped', scope: 'packages/tools/' })
      ).not.toThrow();
    });

    it('scoped mode releases scope on completion', async () => {
      const { promise } = pipeline.dispatch('test-agent', 'task 1', { writeMode: 'scoped', scope: 'packages/relay/' });
      await promise;
      // After completion, same scope should be available
      expect(() =>
        pipeline.dispatch('test-agent', 'task 2', { writeMode: 'scoped', scope: 'packages/relay/' })
      ).not.toThrow();
    });

    it('dispatch with options stores writeMode and scope on task', async () => {
      const { taskId } = pipeline.dispatch('test-agent', 'task 1', { writeMode: 'scoped', scope: 'packages/relay/' });
      const task = pipeline.getTask(taskId);
      expect(task?.writeMode).toBe('scoped');
      expect(task?.scope).toBe('packages/relay/');
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

    it('rejects entire batch when any agent is missing (all-or-nothing)', () => {
      const { taskIds, errors } = pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1' },
        { agentId: 'missing', task: 'task 2' },
      ]);
      expect(taskIds).toHaveLength(0); // all-or-nothing: zero dispatched
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('missing');
    });

    it('rejects sequential mode in parallel dispatch', () => {
      const { taskIds, errors } = pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1', options: { writeMode: 'sequential' } },
      ]);
      expect(taskIds).toHaveLength(0);
      expect(errors[0]).toContain('sequential');
    });

    it('rejects overlapping scopes in parallel dispatch', () => {
      const { taskIds, errors } = pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1', options: { writeMode: 'scoped', scope: 'packages/relay/' } },
        { agentId: 'test-agent', task: 'task 2', options: { writeMode: 'scoped', scope: 'packages/relay/src/' } },
      ]);
      expect(taskIds).toHaveLength(0);
      expect(errors[0]).toContain('overlapping');
    });

    it('allows non-overlapping scopes in parallel dispatch', () => {
      workers.set('agent-b', mockWorker('result-b'));
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });
      const { taskIds, errors } = pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1', options: { writeMode: 'scoped', scope: 'packages/relay/' } },
        { agentId: 'agent-b', task: 'task 2', options: { writeMode: 'scoped', scope: 'packages/tools/' } },
      ]);
      expect(taskIds).toHaveLength(2);
      expect(errors).toHaveLength(0);
    });
  });
});
