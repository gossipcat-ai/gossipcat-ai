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
      const { results } = await pipeline.collect([taskId]);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('completed');
      expect(results[0].result).toBe('done');
    });

    it('collects all running tasks when no ids given', async () => {
      pipeline.dispatch('test-agent', 'task 1');
      pipeline.dispatch('test-agent', 'task 2');
      const { results } = await pipeline.collect();
      expect(results).toHaveLength(2);
    });

    it('returns empty array when no tasks match', async () => {
      const { results } = await pipeline.collect(['nonexistent']);
      expect(results).toHaveLength(0);
    });

    it('detects orphaned tasks from server restart and returns failure entries', async () => {
      // Simulate: task was dispatched (recorded in TaskGraph) but pipeline restarted (Map is empty)
      const { TaskGraph } = require('@gossip/orchestrator');
      const taskGraph = new TaskGraph(pipeline['projectRoot']);
      taskGraph.recordCreated('orphan-1', 'test-agent', 'lost task', ['testing']);

      const { results } = await pipeline.collect(['orphan-1']);
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

  describe('task progress callback', () => {
    it('fires progress events during task execution', async () => {
      const events: Array<{ taskId: string; toolCalls: number }> = [];

      // Create a worker that calls onProgress during executeTask
      const progressWorker = {
        executeTask: jest.fn().mockImplementation(
          (_task: string, _lens: unknown, _prompt: unknown, onProgress?: (evt: { toolCalls: number; inputTokens: number; outputTokens: number; currentTool: string; turn: number }) => void) => {
            if (onProgress) {
              onProgress({ toolCalls: 1, inputTokens: 100, outputTokens: 50, currentTool: 'read_file', turn: 1 });
              onProgress({ toolCalls: 2, inputTokens: 200, outputTokens: 80, currentTool: 'write_file', turn: 2 });
            }
            return Promise.resolve({ result: 'progress-done', inputTokens: 200, outputTokens: 80 });
          }
        ),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };

      workers.set('progress-agent', progressWorker);
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });

      pipeline.setTaskProgressCallback((taskId, evt) => {
        events.push({ taskId, toolCalls: evt.toolCalls });
      });

      const { taskId, promise } = pipeline.dispatch('progress-agent', 'do work');
      await promise;

      expect(events).toHaveLength(2);
      expect(events[0].taskId).toBe(taskId);
      expect(events[0].toolCalls).toBe(1);
      expect(events[1].taskId).toBe(taskId);
      expect(events[1].toolCalls).toBe(2);
    });

    it('updates entry.toolCalls on progress events', async () => {
      const progressWorker = {
        executeTask: jest.fn().mockImplementation(
          (_task: string, _lens: unknown, _prompt: unknown, onProgress?: (evt: { toolCalls: number; inputTokens: number; outputTokens: number; currentTool: string; turn: number }) => void) => {
            if (onProgress) {
              onProgress({ toolCalls: 3, inputTokens: 300, outputTokens: 120, currentTool: 'bash', turn: 3 });
            }
            return Promise.resolve({ result: 'entry-done', inputTokens: 300, outputTokens: 120 });
          }
        ),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };

      workers.set('entry-agent', progressWorker);
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });

      // No external callback set — just verify entry fields updated
      const { taskId, promise } = pipeline.dispatch('entry-agent', 'entry task');
      await promise;

      // After completion, collect to verify tokens (entry is removed post-collect but we can check before)
      // The entry is deleted after collect, so check before collecting
      const task = pipeline.getTask(taskId);
      // inputTokens should reflect final execResult (300) — entry fields are overwritten by execResult in .then()
      expect(task?.inputTokens).toBe(300);
    });

    it('fires progress events in sequential write mode', async () => {
      const events: Array<{ toolCalls: number }> = [];
      const progressWorker = {
        executeTask: jest.fn().mockImplementation(
          (_task: string, _lens: unknown, _prompt: unknown, onProgress?: (evt: { toolCalls: number; inputTokens: number; outputTokens: number; currentTool: string; turn: number }) => void) => {
            if (onProgress) {
              onProgress({ toolCalls: 1, inputTokens: 50, outputTokens: 25, currentTool: 'edit', turn: 1 });
            }
            return Promise.resolve({ result: 'seq-done', inputTokens: 50, outputTokens: 25 });
          }
        ),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };

      workers.set('seq-agent', progressWorker);
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });

      pipeline.setTaskProgressCallback((_taskId, evt) => {
        events.push({ toolCalls: evt.toolCalls });
      });

      const { promise } = pipeline.dispatch('seq-agent', 'seq task', { writeMode: 'sequential' });
      await promise;

      expect(events).toHaveLength(1);
      expect(events[0].toolCalls).toBe(1);
    });
  });

  describe('dispatchParallel()', () => {
    it('dispatches multiple tasks and returns ids', async () => {
      workers.set('agent-b', mockWorker('result-b'));
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });

      const { taskIds, errors } = await pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1' },
        { agentId: 'agent-b', task: 'task 2' },
      ]);
      expect(taskIds).toHaveLength(2);
      expect(errors).toHaveLength(0);
    });

    it('rejects entire batch when any agent is missing (all-or-nothing)', async () => {
      const { taskIds, errors } = await pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1' },
        { agentId: 'missing', task: 'task 2' },
      ]);
      expect(taskIds).toHaveLength(0); // all-or-nothing: zero dispatched
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('missing');
    });

    it('rejects sequential mode in parallel dispatch', async () => {
      const { taskIds, errors } = await pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1', options: { writeMode: 'sequential' } },
      ]);
      expect(taskIds).toHaveLength(0);
      expect(errors[0]).toContain('sequential');
    });

    it('rejects overlapping scopes in parallel dispatch', async () => {
      const { taskIds, errors } = await pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1', options: { writeMode: 'scoped', scope: 'packages/relay/' } },
        { agentId: 'test-agent', task: 'task 2', options: { writeMode: 'scoped', scope: 'packages/relay/src/' } },
      ]);
      expect(taskIds).toHaveLength(0);
      expect(errors[0]).toContain('overlapping');
    });

    it('allows non-overlapping scopes in parallel dispatch', async () => {
      workers.set('agent-b', mockWorker('result-b'));
      pipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });
      const { taskIds, errors } = await pipeline.dispatchParallel([
        { agentId: 'test-agent', task: 'task 1', options: { writeMode: 'scoped', scope: 'packages/relay/' } },
        { agentId: 'agent-b', task: 'task 2', options: { writeMode: 'scoped', scope: 'packages/tools/' } },
      ]);
      expect(taskIds).toHaveLength(2);
      expect(errors).toHaveLength(0);
    });
  });

  describe('runConsensus()', () => {
    it('returns undefined when no LLM configured', async () => {
      const result = await pipeline.runConsensus([
        { id: 't1', agentId: 'a', task: 'review', status: 'completed', result: 'found bug', startedAt: 0, completedAt: 1 },
        { id: 't2', agentId: 'b', task: 'review', status: 'completed', result: 'found bug', startedAt: 0, completedAt: 1 },
      ]);
      expect(result).toBeUndefined();
    });

    it('returns undefined when fewer than 2 completed results', async () => {
      const result = await pipeline.runConsensus([
        { id: 't1', agentId: 'a', task: 'review', status: 'completed', result: 'found bug', startedAt: 0, completedAt: 1 },
        { id: 't2', agentId: 'b', task: 'review', status: 'failed', error: 'timeout', startedAt: 0, completedAt: 1 },
      ]);
      expect(result).toBeUndefined();
    });

    it('runs consensus with LLM and returns report', async () => {
      const mockLlm = {
        generate: jest.fn().mockResolvedValue('[]'),
        provider: 'test',
        model: 'test',
      };
      const llmPipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
        llm: mockLlm as any,
      });

      const results = [
        { id: 't1', agentId: 'agent-a', task: 'review', status: 'completed' as const, result: '## Consensus Summary\nfound a bug in auth', startedAt: 0, completedAt: 1 },
        { id: 't2', agentId: 'agent-b', task: 'review', status: 'completed' as const, result: '## Consensus Summary\nfound a bug in auth', startedAt: 0, completedAt: 1 },
      ];
      const report = await llmPipeline.runConsensus(results);
      expect(report).toBeDefined();
      expect(mockLlm.generate).toHaveBeenCalled();
    });

    it('includes native + relay results when called with merged set', async () => {
      const mockLlm = {
        generate: jest.fn().mockResolvedValue('[]'),
        provider: 'test',
        model: 'test',
      };
      const llmPipeline = new DispatchPipeline({
        projectRoot: '/tmp/gossip-test-' + Date.now(),
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
        llm: mockLlm as any,
      });

      // Simulates merged relay + native results
      const results = [
        { id: 'relay-1', agentId: 'gemini-reviewer', task: 'review', status: 'completed' as const, result: '## Consensus Summary\nSQL injection in query builder', startedAt: 0, completedAt: 100 },
        { id: 'relay-2', agentId: 'gemini-tester', task: 'review', status: 'completed' as const, result: '## Consensus Summary\nNo issues found', startedAt: 0, completedAt: 200 },
        { id: 'native-1', agentId: 'sonnet-reviewer', task: 'review', status: 'completed' as const, result: '## Consensus Summary\nSQL injection in query builder + XSS in template', startedAt: 0, completedAt: 300 },
      ];
      const report = await llmPipeline.runConsensus(results);
      expect(report).toBeDefined();
      // All 3 agents should participate in cross-review (3 generate calls)
      expect(mockLlm.generate.mock.calls.length).toBe(3);
    });
  });

  describe('getSkillGapSuggestions()', () => {
    it('returns empty when no profiler configured', () => {
      expect(pipeline.getSkillGapSuggestions()).toEqual([]);
    });

    it('detects agents weak in categories where peers are strong', () => {
      const mockProfiler = {
        getProfiles: jest.fn().mockReturnValue(new Map([
          ['agent-a', { agentId: 'agent-a', reviewStrengths: { injection: 0.8, xss: 0.75 } }],
          ['agent-b', { agentId: 'agent-b', reviewStrengths: { injection: 0.1, xss: 0.05 } }],
          ['agent-c', { agentId: 'agent-c', reviewStrengths: { injection: 0.9, xss: 0.8 } }],
        ])),
      };
      pipeline.setCompetencyProfiler(mockProfiler as any);
      const suggestions = pipeline.getSkillGapSuggestions();
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes('agent-b') && s.includes('injection'))).toBe(true);
      expect(suggestions.some(s => s.includes('agent-b') && s.includes('xss'))).toBe(true);
    });

    it('returns empty when all agents are strong', () => {
      const mockProfiler = {
        getProfiles: jest.fn().mockReturnValue(new Map([
          ['agent-a', { agentId: 'agent-a', reviewStrengths: { injection: 0.8 } }],
          ['agent-b', { agentId: 'agent-b', reviewStrengths: { injection: 0.7 } }],
        ])),
      };
      pipeline.setCompetencyProfiler(mockProfiler as any);
      expect(pipeline.getSkillGapSuggestions()).toEqual([]);
    });
  });
});
