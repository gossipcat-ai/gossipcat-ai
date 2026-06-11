/**
 * Regression tests for the all-relay consensus resolutionRoots DROP
 * (root cause of stale-anchor false disputes in round 840fcedf, recurrence of
 * the #389 class).
 *
 * The existing tests in consensus-engine-resolution-roots.test.ts construct
 * ConsensusEngine directly and therefore CANNOT catch a regression in the
 * plumbing that feeds resolutionRoots INTO the engine. These tests drive that
 * plumbing:
 *
 *   1. ConsensusCoordinator.runConsensus forwards per-round roots to the engine.
 *   2. Per-round roots OVERRIDE the coordinator's constructor default.
 *   3. ConsensusEngine.updateWorktreeRoots unions TaskEntry.resolutionRoots.
 */
import { realpathSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Capture the config each ConsensusEngine is constructed with, while stubbing
// out the heavy run()/synthesize() path so the coordinator test stays fast.
const engineConfigs: Array<{ resolutionRoots?: readonly string[] }> = [];

jest.mock('../../packages/orchestrator/src/consensus-engine', () => {
  const actual = jest.requireActual('../../packages/orchestrator/src/consensus-engine');
  class StubEngine {
    config: any;
    constructor(config: any) {
      this.config = config;
      engineConfigs.push(config);
    }
    async run() {
      return {
        confirmed: [], disputed: [], unverified: [], unique: [],
        insights: [], newFindings: [], signals: [],
        summary: 'stub',
      };
    }
  }
  return { ...actual, ConsensusEngine: StubEngine };
});

import { ConsensusCoordinator } from '../../packages/orchestrator/src/consensus-coordinator';
import type { TaskEntry } from '../../packages/orchestrator/src/types';

const makeLlm = (): any => ({
  generate: jest.fn(async () => ({ text: '[]', usage: { inputTokens: 0, outputTokens: 0 } })),
});

const completed = (agentId: string): TaskEntry => ({
  id: `t-${agentId}`,
  agentId,
  task: 'review X',
  status: 'completed',
  result: '<agent_finding type="finding" severity="low">noted</agent_finding>',
  startedAt: Date.now(),
});

describe('all-relay consensus resolutionRoots plumbing', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    engineConfigs.length = 0;
    tmp = mkdtempSync(join(tmpdir(), 'crp-'));
    root = realpathSync(tmp);
  });

  it('ConsensusCoordinator.runConsensus forwards per-round roots to the engine', async () => {
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt')));
    const coordinator = new ConsensusCoordinator({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: root,
      keyProvider: null,
    });

    await coordinator.runConsensus(
      [completed('relay-a'), completed('relay-b')],
      [wt],
    );

    expect(engineConfigs).toHaveLength(1);
    expect(engineConfigs[0].resolutionRoots).toEqual([wt]);
  });

  it('per-round roots OVERRIDE the coordinator constructor default', async () => {
    const ctorRoot = realpathSync(mkdtempSync(join(tmp, 'ctor')));
    const perRoundRoot = realpathSync(mkdtempSync(join(tmp, 'round')));

    const coordinator = new ConsensusCoordinator({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: root,
      keyProvider: null,
      resolutionRoots: [ctorRoot],
    });

    // Per-round value supplied → must REPLACE the constructor default.
    await coordinator.runConsensus(
      [completed('relay-a'), completed('relay-b')],
      [perRoundRoot],
    );
    expect(engineConfigs[engineConfigs.length - 1].resolutionRoots).toEqual([perRoundRoot]);

    // No per-round value → constructor default is used (back-compat).
    await coordinator.runConsensus([completed('relay-a'), completed('relay-b')]);
    expect(engineConfigs[engineConfigs.length - 1].resolutionRoots).toEqual([ctorRoot]);

    // Empty per-round array → treated as absent, constructor default used.
    await coordinator.runConsensus([completed('relay-a'), completed('relay-b')], []);
    expect(engineConfigs[engineConfigs.length - 1].resolutionRoots).toEqual([ctorRoot]);
  });
});

describe('ConsensusEngine.updateWorktreeRoots unions TaskEntry.resolutionRoots', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crp-uwr-'));
    root = realpathSync(tmp);
  });

  it('per-task resolutionRoots are unioned into currentWorktreeRoots', () => {
    // Use the REAL engine here (not the stubbed one) via requireActual so the
    // private updateWorktreeRoots logic is exercised, not the mock.
    const { ConsensusEngine: RealEngine } = jest.requireActual(
      '../../packages/orchestrator/src/consensus-engine',
    );
    const taskRoot = realpathSync(mkdtempSync(join(tmp, 'task-wt')));

    const engine = new RealEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: root,
    });

    const entry: TaskEntry = {
      id: 't1',
      agentId: 'relay-a',
      task: 'review',
      status: 'completed',
      result: 'x',
      startedAt: Date.now(),
      resolutionRoots: [taskRoot],
    };

    // updateWorktreeRoots is private — invoke via cast. No config roots, no
    // worktreeInfo: the ONLY source of the root is the TaskEntry field.
    (engine as any).updateWorktreeRoots([entry]);

    const roots: Set<string> = (engine as any).currentWorktreeRoots;
    expect(roots.has(taskRoot)).toBe(true);
  });

  it('TaskEntry roots union alongside worktreeInfo.path and config roots', () => {
    const { ConsensusEngine: RealEngine } = jest.requireActual(
      '../../packages/orchestrator/src/consensus-engine',
    );
    const taskRoot = realpathSync(mkdtempSync(join(tmp, 'task-wt2')));
    const wtInfoRoot = realpathSync(mkdtempSync(join(tmp, 'info-wt')));
    const configRoot = realpathSync(mkdtempSync(join(tmp, 'cfg-wt')));

    const engine = new RealEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: root,
      resolutionRoots: [configRoot],
    });

    const entry: TaskEntry = {
      id: 't1',
      agentId: 'relay-a',
      task: 'review',
      status: 'completed',
      result: 'x',
      startedAt: Date.now(),
      worktreeInfo: { path: wtInfoRoot, branch: 'feat' },
      resolutionRoots: [taskRoot],
    };

    (engine as any).updateWorktreeRoots([entry], [configRoot]);

    const roots: Set<string> = (engine as any).currentWorktreeRoots;
    expect(roots.has(taskRoot)).toBe(true);
    expect(roots.has(wtInfoRoot)).toBe(true);
    expect(roots.has(configRoot)).toBe(true);
  });

  it('non-absolute TaskEntry.resolutionRoots entries are skipped (fail-soft)', () => {
    const { ConsensusEngine: RealEngine } = jest.requireActual(
      '../../packages/orchestrator/src/consensus-engine',
    );
    const absRoot = realpathSync(mkdtempSync(join(tmp, 'abs-wt')));

    const engine = new RealEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: root,
    });

    const entry: TaskEntry = {
      id: 't1',
      agentId: 'relay-a',
      task: 'review',
      status: 'completed',
      result: 'x',
      startedAt: Date.now(),
      // Mix of one absolute (kept) and two non-absolute (skipped) entries.
      resolutionRoots: [absRoot, 'relative/path', './also-relative'],
    };

    // updateWorktreeRoots must not throw on non-absolute entries — unlike the
    // constructor's programmer-error contract, this path fails soft.
    expect(() => (engine as any).updateWorktreeRoots([entry])).not.toThrow();

    const roots: Set<string> = (engine as any).currentWorktreeRoots;
    expect(roots.has(absRoot)).toBe(true);
    // The relative entries were resolve()'d against cwd in the old code; assert
    // they are NOT present in either raw or resolved form.
    expect([...roots].some(r => r.endsWith('relative/path'))).toBe(false);
    expect([...roots].some(r => r.endsWith('also-relative'))).toBe(false);
    expect(roots.size).toBe(1);
  });
});

describe('DispatchPipeline.collect forwards options.resolutionRoots to runConsensus', () => {
  // Use the real (non-stubbed) modules here — this block exercises the pipeline
  // → runConsensus signature, spying on runConsensus so we don't run a real
  // consensus round. requireActual bypasses the module-level engine mock above.
  const { DispatchPipeline } = jest.requireActual('@gossip/orchestrator');
  const { TaskStreamEventType } = jest.requireActual('@gossip/orchestrator');

  let projectRoot: string;
  let worktree: string;

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-rr-collect-proj-')));
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-rr-collect-wt-')));
  });

  function relayWorker() {
    return {
      executeTask: jest.fn().mockImplementation(async function* () {
        yield {
          type: TaskStreamEventType.FINAL_RESULT,
          payload: { result: 'done', inputTokens: 0, outputTokens: 0 },
          timestamp: Date.now(),
        };
      }),
      subscribeToBatch: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('collect({ consensus, resolutionRoots }) forwards roots to runConsensus', async () => {
    const workers = new Map<string, any>();
    const pipeline = new DispatchPipeline({
      projectRoot,
      workers,
      registryGet: (id: string) => ({ id, provider: 'local', model: 'mock', skills: [] }),
      llm: makeLlm(),
    });
    const spy = jest
      .spyOn(pipeline as any, 'runConsensus')
      .mockResolvedValue(undefined);

    workers.set('relay-a', relayWorker());
    workers.set('relay-b', relayWorker());
    const a = pipeline.dispatch('relay-a', 'review');
    const b = pipeline.dispatch('relay-b', 'review');
    await Promise.all([a.finalResultPromise, b.finalResultPromise]);

    await pipeline.collect([a.taskId, b.taskId], 120_000, {
      consensus: true,
      resolutionRoots: [worktree],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual([worktree]);
  });

  it('collect without resolutionRoots forwards undefined (back-compat)', async () => {
    const workers = new Map<string, any>();
    const pipeline = new DispatchPipeline({
      projectRoot,
      workers,
      registryGet: (id: string) => ({ id, provider: 'local', model: 'mock', skills: [] }),
      llm: makeLlm(),
    });
    const spy = jest
      .spyOn(pipeline as any, 'runConsensus')
      .mockResolvedValue(undefined);

    workers.set('relay-a', relayWorker());
    workers.set('relay-b', relayWorker());
    const a = pipeline.dispatch('relay-a', 'review');
    const b = pipeline.dispatch('relay-b', 'review');
    await Promise.all([a.finalResultPromise, b.finalResultPromise]);

    await pipeline.collect([a.taskId, b.taskId], 120_000, { consensus: true });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBeUndefined();
  });
});
