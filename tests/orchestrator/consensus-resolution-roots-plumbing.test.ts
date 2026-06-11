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
});
