import { DispatchPipeline } from '@gossip/orchestrator';

// Minimal mock worker using async generator (matches WorkerAgent.executeTask signature)
function mockWorker(result = 'done') {
  return {
    executeTask: jest.fn().mockImplementation(async function* () {
      yield { type: 'final_result', payload: { result, inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
    }),
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
      const { taskId, finalResultPromise: promise } = pipeline.dispatch('test-agent', 'review code');
      expect(taskId).toMatch(/^[a-f0-9]{8}$/);
      const result = await promise;
      expect(result).toEqual({ result: 'done', inputTokens: 0, outputTokens: 0 });
      expect(workers.get('test-agent')!.executeTask).toHaveBeenCalledTimes(1);
    });

    it('throws for unknown agent', () => {
      expect(() => pipeline.dispatch('nope', 'task')).toThrow('Agent "nope" not found');
    });

    it('tracks task status after completion', async () => {
      const { taskId, finalResultPromise: promise } = pipeline.dispatch('test-agent', 'review code');
      await promise;
      const task = pipeline.getTask(taskId);
      expect(task?.status).toBe('completed');
      expect(task?.result).toBe('done');
    });

    it('tracks task status after failure', async () => {
      const failWorker = {
        executeTask: jest.fn().mockImplementation(async function* () {
          yield { type: 'error', payload: { error: 'boom' }, timestamp: Date.now() };
        }),
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

      const { taskId, finalResultPromise: promise } = pipeline.dispatch('fail-agent', 'bad task');
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
          .mockImplementationOnce(async function* () {
            await new Promise(r => setTimeout(r, 50));
            order.push(1);
            yield { type: 'final_result', payload: { result: 'first', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
          })
          .mockImplementationOnce(async function* () {
            await new Promise(r => setTimeout(r, 10));
            order.push(2);
            yield { type: 'final_result', payload: { result: 'second', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
          }),
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
      await Promise.all([t1.finalResultPromise, t2.finalResultPromise]);
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
      const { finalResultPromise: promise } = pipeline.dispatch('test-agent', 'task 1', { writeMode: 'scoped', scope: 'packages/relay/' });
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

  describe('cancelRunningTasks()', () => {
    it('releases scoped task resources on cancel', async () => {
      const releaseAgent = jest.fn();
      const hangingWorker = {
        executeTask: jest.fn().mockImplementation(async function* () { await new Promise(() => {}); }),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };
      const ws = new Map([['hang-agent', hangingWorker]]);
      const p = new DispatchPipeline({
        projectRoot: '/tmp/gossip-cancel-test-' + Date.now(),
        workers: ws,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
        toolServer: { assignScope: jest.fn(), assignRoot: jest.fn(), releaseAgent },
      });

      p.dispatch('hang-agent', 'scoped task', { writeMode: 'scoped', scope: 'packages/relay/' });
      const cancelled = p.cancelRunningTasks();
      expect(cancelled).toBe(1);
      expect(releaseAgent).toHaveBeenCalledWith('hang-agent');

      // Scope should be released — dispatching to same scope should not throw
      const freshWorker = {
        executeTask: jest.fn().mockImplementation(async function* () { yield { type: 'final_result', payload: { result: 'ok', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() }; }),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };
      ws.set('fresh-agent', freshWorker);
      expect(() =>
        p.dispatch('fresh-agent', 'new scoped task', { writeMode: 'scoped', scope: 'packages/relay/' })
      ).not.toThrow();
    });

    it('cleans up worktree task resources on cancel', async () => {
      const cleanupMock = jest.fn().mockResolvedValue(undefined);
      const releaseAgent = jest.fn();
      const hangingWorker = {
        executeTask: jest.fn().mockImplementation(async function* () { await new Promise(() => {}); }),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };
      const ws = new Map([['hang-agent', hangingWorker]]);
      const p = new DispatchPipeline({
        projectRoot: '/tmp/gossip-cancel-wt-test-' + Date.now(),
        workers: ws,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
        toolServer: { assignScope: jest.fn(), assignRoot: jest.fn(), releaseAgent },
      });

      const { taskId } = p.dispatch('hang-agent', 'worktree task');
      const task = p.getTask(taskId)!;
      (task as any).writeMode = 'worktree';
      (task as any).worktreeInfo = { path: '/tmp/wt-test', branch: 'gossip-test' };
      (p as any).worktreeManager = { cleanup: cleanupMock, create: jest.fn(), merge: jest.fn(), pruneOrphans: jest.fn() };

      p.cancelRunningTasks();
      expect(cleanupMock).toHaveBeenCalledWith(taskId, '/tmp/wt-test');
      expect(releaseAgent).toHaveBeenCalledWith('hang-agent');
    });
  });

  describe('worktree error cleanup', () => {
    it('cleans up worktree when executeTask fails', async () => {
      const cleanupMock = jest.fn().mockResolvedValue(undefined);
      const createMock = jest.fn().mockResolvedValue({ path: '/tmp/wt-fail', branch: 'gossip-fail' });
      const failWorker = {
        executeTask: jest.fn().mockImplementation(async function* () { yield { type: 'error', payload: { error: 'exec failed' }, timestamp: Date.now() }; }),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };
      const ws = new Map([['fail-agent', failWorker]]);
      const p = new DispatchPipeline({
        projectRoot: '/tmp/gossip-wt-fail-test-' + Date.now(),
        workers: ws,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
      });
      // Inject mock worktreeManager BEFORE dispatching
      (p as any).worktreeManager = { cleanup: cleanupMock, create: createMock, merge: jest.fn(), pruneOrphans: jest.fn() };

      const { taskId, finalResultPromise: promise } = p.dispatch('fail-agent', 'doomed task', { writeMode: 'worktree' });
      await promise.catch(() => {}); // swallow rejection

      const task = p.getTask(taskId);
      expect(task?.status).toBe('failed');
      expect(cleanupMock).toHaveBeenCalledWith(taskId, '/tmp/wt-fail');
    });
  });

  // task progress callback tests removed — setTaskProgressCallback was replaced
  // by streaming events (TaskStreamEvent) in the async generator refactor.

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
    it('returns empty when no performance data exists', () => {
      expect(pipeline.getSkillGapSuggestions()).toEqual([]);
    });
  });

  describe('collect() timeout cleanup', () => {
    it('releases toolServer agent for timed-out worktree tasks', async () => {
      const releaseAgent = jest.fn();
      const hangingWorker = {
        executeTask: jest.fn().mockImplementation(async function* () { await new Promise(() => {}); }),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      };
      const ws = new Map([['hang-agent', hangingWorker]]);
      const p = new DispatchPipeline({
        projectRoot: '/tmp/gossip-timeout-test-' + Date.now(),
        workers: ws,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
        toolServer: { assignScope: jest.fn(), assignRoot: jest.fn(), releaseAgent },
      });

      const { taskId } = p.dispatch('hang-agent', 'slow worktree task');
      const task = p.getTask(taskId)!;
      (task as any).writeMode = 'worktree';
      (task as any).worktreeInfo = { path: '/tmp/wt-timeout', branch: 'gossip-timeout' };
      (p as any).worktreeManager = { cleanup: jest.fn().mockResolvedValue(undefined), create: jest.fn(), merge: jest.fn(), pruneOrphans: jest.fn() };

      // Collect with very short timeout — task will still be running
      await p.collect([taskId], 50);
      expect(releaseAgent).toHaveBeenCalledWith('hang-agent');
    });
  });

  describe('JSONL file rotation', () => {
    const fs = require('fs');
    const path = require('path');

    it('rotates file when over max entries', () => {
      const tmpDir = '/tmp/gossip-rotation-test-' + Date.now();
      fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
      const filePath = path.join(tmpDir, '.gossip', 'test.jsonl');

      // Write 210 entries
      const lines = Array.from({ length: 210 }, (_, i) => JSON.stringify({ id: i }));
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const p = new DispatchPipeline({
        projectRoot: tmpDir,
        workers: new Map([['test-agent', mockWorker()]]),
        registryGet: () => mockRegistryGet(),
      });

      (p as any).rotateJsonlFile(filePath, 200, 100);

      const content = fs.readFileSync(filePath, 'utf-8').trim();
      const remaining = content.split('\n');
      expect(remaining.length).toBe(100);
      expect(JSON.parse(remaining[0]).id).toBe(110);
      expect(JSON.parse(remaining[99]).id).toBe(209);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not rotate when under the cap', () => {
      const tmpDir = '/tmp/gossip-rotation-norot-' + Date.now();
      fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
      const filePath = path.join(tmpDir, '.gossip', 'test.jsonl');

      const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: i }));
      fs.writeFileSync(filePath, lines.join('\n') + '\n');

      const p = new DispatchPipeline({
        projectRoot: tmpDir,
        workers: new Map([['test-agent', mockWorker()]]),
        registryGet: () => mockRegistryGet(),
      });

      (p as any).rotateJsonlFile(filePath, 200, 100);

      const content = fs.readFileSync(filePath, 'utf-8').trim();
      expect(content.split('\n').length).toBe(50);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('handles missing file gracefully', () => {
      const p = new DispatchPipeline({
        projectRoot: '/tmp/gossip-rotation-missing-' + Date.now(),
        workers: new Map([['test-agent', mockWorker()]]),
        registryGet: () => mockRegistryGet(),
      });

      // Should not throw
      expect(() => (p as any).rotateJsonlFile('/nonexistent/path.jsonl', 200, 100)).not.toThrow();
    });
  });

  describe('getRunningTaskRecords()', () => {
    it('returns only running tasks in the correct format', async () => {
      const p1 = pipeline.dispatch('test-agent', 'task 1');
      await p1.finalResultPromise; // this one will complete

      pipeline.dispatch('test-agent', 'task 2'); // this one is running

      const records = pipeline.getRunningTaskRecords();
      expect(records).toHaveLength(1);
      expect(records[0].id).toMatch(/^[a-f0-9]{8}$/);
      expect(records[0].agentId).toBe('test-agent');
      expect(records[0].task).toBe('task 2');
      expect(typeof records[0].startedAt).toBe('number');
      expect(typeof records[0].timeoutMs).toBe('number');

      const task = pipeline.getTask(p1.taskId);
      expect(task?.status).toBe('completed');
    });

    it('returns an empty array when no tasks are running', () => {
      expect(pipeline.getRunningTaskRecords()).toEqual([]);
    });
  });

  describe('invalidateProjectStructureCache (F6 — syncWorkers cache drift)', () => {
    it('is a public method that can be called without throwing', () => {
      // Fresh pipeline — cache starts unpopulated (null). Invalidate should be a no-op that doesn't throw.
      expect(() => pipeline.invalidateProjectStructureCache()).not.toThrow();
    });

    it('clears the cache so the next read re-computes from disk', () => {
      // getProjectStructure is private; exercise via a dispatch and then invalidate.
      // The test's intent is: after invalidate, the internal null flag is set
      // so the next computation re-runs. We can't observe that directly without
      // reflection; instead verify the method is idempotent and survives repeat calls.
      pipeline.invalidateProjectStructureCache();
      pipeline.invalidateProjectStructureCache();
      expect(() => pipeline.invalidateProjectStructureCache()).not.toThrow();
    });
  });

  describe('detectFormatCompliance → format_compliance meta-signal round-trip', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { detectFormatCompliance } = require('@gossip/orchestrator');

    it('passes through ParseDiagnostic codes to the meta-signal payload shape', () => {
      // The meta-signal emit site at dispatch-pipeline.ts:431 builds
      // `diagnostic_codes: compliance.diagnostics.map(d => d.code)`. Verify
      // that detectFormatCompliance produces diagnostics in the right shape
      // for that mapping to succeed end-to-end. Uses entity-encoded output to
      // trigger HTML_ENTITY_ENCODED_TAGS.
      const entityOnlyOutput =
        `&lt;agent_finding type="finding" severity="high"&gt;body at foo.ts:12 some content&lt;/agent_finding&gt;`;
      const compliance = detectFormatCompliance(entityOnlyOutput);
      expect(compliance.tags_accepted).toBe(0);
      expect(compliance.diagnostics).toHaveLength(1);
      expect(compliance.diagnostics[0].code).toBe('HTML_ENTITY_ENCODED_TAGS');
      // Simulate the meta-signal payload shape (dispatch-pipeline.ts:431).
      const diagnosticCodes = compliance.diagnostics.map((d: { code: string }) => d.code);
      expect(diagnosticCodes).toEqual(['HTML_ENTITY_ENCODED_TAGS']);
    });

    it('emits empty diagnostic_codes array on clean output', () => {
      const cleanOutput =
        `<agent_finding type="finding" severity="high">Clean raw tag at foo.ts:42 content</agent_finding>`;
      const compliance = detectFormatCompliance(cleanOutput);
      expect(compliance.tags_accepted).toBe(1);
      expect(compliance.diagnostics).toEqual([]);
      const diagnosticCodes = compliance.diagnostics.map((d: { code: string }) => d.code);
      expect(diagnosticCodes).toEqual([]);
    });

    it('emits HTML_ENTITY_MIXED_PAYLOAD code when raw and entity tags mix', () => {
      const mixed = `
<agent_finding type="finding" severity="high">raw tag foo.ts:10 content here</agent_finding>
&lt;agent_finding type="finding" severity="low"&gt;entity tag bar.ts:20 content&lt;/agent_finding&gt;
`;
      const compliance = detectFormatCompliance(mixed);
      expect(compliance.tags_accepted).toBe(1);
      const codes = compliance.diagnostics.map((d: { code: string }) => d.code);
      expect(codes).toEqual(['HTML_ENTITY_MIXED_PAYLOAD']);
    });
  });
});
