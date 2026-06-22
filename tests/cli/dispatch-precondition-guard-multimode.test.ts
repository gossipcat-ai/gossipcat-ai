/**
 * Tests that runDispatchPreconditionGuard is invoked for parallel and consensus
 * dispatch paths (Unit 2 orchestrator signal pipeline, multi-mode wiring).
 *
 * The guard must fire once per dispatch call (not per task), fire after task IDs
 * are minted, and never block or fail the dispatch. The spy verifies the call
 * shape mirrors the single-dispatch call at dispatch.ts:717-725.
 */

import { ctx } from '../../apps/cli/src/mcp-context';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the precondition runner so we can spy without real git I/O.
jest.mock('../../apps/cli/src/handlers/orchestrator-precondition-runner', () => {
  const actual = jest.requireActual('../../apps/cli/src/handlers/orchestrator-precondition-runner');
  return {
    ...actual,
    runDispatchPreconditionGuard: jest.fn().mockResolvedValue({ warnings: [] }),
  };
});

import { runDispatchPreconditionGuard } from '../../apps/cli/src/handlers/orchestrator-precondition-runner';
const mockedGuard = runDispatchPreconditionGuard as unknown as jest.Mock;

import { handleDispatchParallel, handleDispatchConsensus } from '../../apps/cli/src/handlers/dispatch';

// ---------------------------------------------------------------------------
// ctx helpers (mirrors dispatch-parallel-autodiscover-worktrees.test.ts)
// ---------------------------------------------------------------------------

function makeMainAgent(overrides: Record<string, any> = {}): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'default-task-id' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null),
    getLlm: jest.fn().mockReturnValue(null),
    getLLM: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]),
    getSkillGapSuggestions: jest.fn().mockReturnValue([]),
    getSkillIndex: jest.fn().mockReturnValue(null),
    getSessionGossip: jest.fn().mockReturnValue([]),
    getSessionConsensusHistory: jest.fn().mockReturnValue([]),
    recordNativeTask: jest.fn(),
    recordNativeTaskCompleted: jest.fn(),
    recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined),
    getChainContext: jest.fn().mockReturnValue(''),
    generateLensesForAgents: jest.fn().mockResolvedValue(new Map()),
    dispatchParallel: jest.fn().mockResolvedValue({ taskIds: ['p-1'], errors: [] }),
    dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: ['p-1'], errors: [] }),
    getTask: jest.fn().mockReturnValue({ agentId: 'gemini-tester' }),
    scopeTracker: {
      hasOverlap: jest.fn().mockReturnValue({ overlaps: false }),
      register: jest.fn(),
      release: jest.fn(),
    },
    pipeline: null,
    projectRoot: '/tmp/gossip-test-project',
    ...overrides,
  };
}

const originalCtx = {
  mainAgent: ctx.mainAgent,
  relay: ctx.relay,
  workers: ctx.workers,
  keychain: ctx.keychain,
  skillEngine: ctx.skillEngine,
  nativeTaskMap: ctx.nativeTaskMap,
  nativeResultMap: ctx.nativeResultMap,
  nativeAgentConfigs: ctx.nativeAgentConfigs,
  pendingConsensusRounds: ctx.pendingConsensusRounds,
  pendingDispatchResolutionRoots: ctx.pendingDispatchResolutionRoots,
  booted: ctx.booted,
  boot: ctx.boot,
  syncWorkersViaKeychain: ctx.syncWorkersViaKeychain,
};

function resetCtx() {
  ctx.mainAgent = makeMainAgent();
  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.nativeAgentConfigs = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.pendingDispatchResolutionRoots = new Map();
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
  ctx.syncWorkersViaKeychain = jest.fn().mockResolvedValue(undefined) as any;
  (ctx as any).skillEngine = null;
}

function restoreCtx() {
  Object.assign(ctx, originalCtx);
}

function writeMinimalConfig(dir: string): void {
  mkdirSync(join(dir, '.gossip', 'skills'), { recursive: true });
  writeFileSync(
    join(dir, '.gossip', 'config.json'),
    JSON.stringify({ main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' } }),
  );
}

// ---------------------------------------------------------------------------
// handleDispatchParallel
// ---------------------------------------------------------------------------

describe('handleDispatchParallel — precondition guard invocation', () => {
  let projectDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'gossip-precond-parallel-')));
    writeMinimalConfig(projectDir);
    process.chdir(projectDir);
    resetCtx();
    mockedGuard.mockReset();
    mockedGuard.mockResolvedValue({ warnings: [] });
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('calls runDispatchPreconditionGuard once for a relay parallel dispatch', async () => {
    await handleDispatchParallel(
      [{ agent_id: 'gemini-tester', task: 'Review X' }],
      /* consensus */ false,
    );

    // Allow the fire-and-forget .then() microtask to settle.
    await new Promise(r => setImmediate(r));

    expect(mockedGuard).toHaveBeenCalledTimes(1);
    const [args] = mockedGuard.mock.calls[0];
    expect(args).toMatchObject({
      projectRoot: projectDir,
      taskId: expect.any(String),
    });
  });

  it('calls guard with first minted task id and passes resolutionRoots through', async () => {
    const roots = ['/some/worktree'];
    // consensus:false → handleDispatchParallel skips worktree auto-discovery, so
    // effectiveResolutionRoots === the caller-supplied roots verbatim. This makes
    // the passthrough deterministic and lets us assert the exact value reached the
    // guard (a regression that dropped roots to [] or undefined would now fail).
    await handleDispatchParallel(
      [{ agent_id: 'gemini-tester', task: 'Review Y' }],
      /* consensus */ false,
      roots,
    );

    await new Promise(r => setImmediate(r));

    expect(mockedGuard).toHaveBeenCalledTimes(1);
    const [args] = mockedGuard.mock.calls[0];
    expect(args.resolutionRoots).toEqual(roots);
    // Bug A wiring: the first task's text + write_mode must reach the guard.
    expect(args.taskText).toBe('Review Y');
    expect(args.writeMode).toBeUndefined();
  });

  it('guard is called only once even for multiple tasks', async () => {
    ctx.mainAgent.dispatchParallel = jest.fn().mockResolvedValue({
      taskIds: ['p-1', 'p-2'],
      errors: [],
    });
    ctx.mainAgent.getTask = jest.fn().mockReturnValue({ agentId: 'gemini-tester' });

    await handleDispatchParallel(
      [
        { agent_id: 'gemini-tester', task: 'Task 1' },
        { agent_id: 'gemini-reviewer', task: 'Task 2' },
      ],
      /* consensus */ false,
    );

    await new Promise(r => setImmediate(r));

    expect(mockedGuard).toHaveBeenCalledTimes(1);
  });

  it('passes ALL non-primary tasks through as additionalTasks (Bug A Fix 1)', async () => {
    ctx.mainAgent.dispatchParallel = jest.fn().mockResolvedValue({
      taskIds: ['p-1', 'p-2'],
      errors: [],
    });
    ctx.mainAgent.getTask = jest.fn().mockReturnValue({ agentId: 'gemini-tester' });

    await handleDispatchParallel(
      [
        { agent_id: 'gemini-tester', task: 'Primary task' },
        { agent_id: 'gemini-reviewer', task: 'Secondary references docs/specs/x.md', write_mode: 'worktree' },
      ],
      /* consensus */ false,
    );

    await new Promise(r => setImmediate(r));

    expect(mockedGuard).toHaveBeenCalledTimes(1);
    const [args] = mockedGuard.mock.calls[0];
    expect(args.taskText).toBe('Primary task');
    expect(args.additionalTasks).toEqual([
      { taskText: 'Secondary references docs/specs/x.md', writeMode: 'worktree' },
    ]);
  });

  it('dispatch succeeds even when runDispatchPreconditionGuard rejects', async () => {
    mockedGuard.mockRejectedValue(new Error('guard exploded'));

    const result: any = await handleDispatchParallel(
      [{ agent_id: 'gemini-tester', task: 'Safe task' }],
      /* consensus */ false,
    );

    // Allow the .catch to settle — no unhandled rejection
    await new Promise(r => setImmediate(r));

    expect(result.content[0].text).toContain('Dispatched');
  });
});

// ---------------------------------------------------------------------------
// handleDispatchConsensus
// ---------------------------------------------------------------------------

describe('handleDispatchConsensus — precondition guard invocation', () => {
  let projectDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'gossip-precond-consensus-')));
    writeMinimalConfig(projectDir);
    process.chdir(projectDir);
    resetCtx();
    mockedGuard.mockReset();
    mockedGuard.mockResolvedValue({ warnings: [] });
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('calls runDispatchPreconditionGuard once for a relay consensus dispatch', async () => {
    await handleDispatchConsensus(
      [
        { agent_id: 'gemini-tester', task: 'Review X security' },
        { agent_id: 'gemini-reviewer', task: 'Review X architecture' },
      ],
    );

    await new Promise(r => setImmediate(r));

    expect(mockedGuard).toHaveBeenCalledTimes(1);
    const [args] = mockedGuard.mock.calls[0];
    expect(args).toMatchObject({
      projectRoot: projectDir,
      taskId: expect.any(String),
    });
  });

  it('passes resolutionRoots through to the guard', async () => {
    const roots = ['/repo/worktrees/agent-abc'];
    await handleDispatchConsensus(
      [{ agent_id: 'gemini-tester', task: 'Review Z' }],
      /* _utility_task_id */ undefined,
      roots,
    );

    await new Promise(r => setImmediate(r));

    expect(mockedGuard).toHaveBeenCalledTimes(1);
    const [args] = mockedGuard.mock.calls[0];
    // handleDispatchConsensus ALWAYS runs resolveDispatchResolutionRoots (a
    // module-internal fn), so the guard receives the post-auto-discovery roots,
    // not the raw input — exact passthrough is environment-dependent and is
    // covered deterministically by the parallel consensus:false test above. Here
    // we only assert the guard received a defined array (catches a drop-to-
    // undefined regression).
    expect(Array.isArray(args.resolutionRoots)).toBe(true);
  });

  it('guard is called only once for a multi-task consensus batch', async () => {
    ctx.mainAgent.dispatchParallel = jest.fn().mockResolvedValue({
      taskIds: ['c-1', 'c-2', 'c-3'],
      errors: [],
    });
    ctx.mainAgent.getTask = jest.fn().mockReturnValue({ agentId: 'gemini-tester' });

    await handleDispatchConsensus([
      { agent_id: 'gemini-tester', task: 'T1' },
      { agent_id: 'gemini-reviewer', task: 'T2' },
      { agent_id: 'sonnet-reviewer', task: 'T3' },
    ]);

    await new Promise(r => setImmediate(r));

    expect(mockedGuard).toHaveBeenCalledTimes(1);
  });

  it('passes non-primary consensus tasks through as additionalTasks (Bug A Fix 1)', async () => {
    ctx.mainAgent.dispatchParallel = jest.fn().mockResolvedValue({
      taskIds: ['c-1', 'c-2'],
      errors: [],
    });
    ctx.mainAgent.getTask = jest.fn().mockReturnValue({ agentId: 'gemini-tester' });

    await handleDispatchConsensus([
      { agent_id: 'gemini-tester', task: 'Primary review' },
      { agent_id: 'gemini-reviewer', task: 'Secondary review docs/specs/y.md', write_mode: 'worktree' },
    ]);

    await new Promise(r => setImmediate(r));

    expect(mockedGuard).toHaveBeenCalledTimes(1);
    const [args] = mockedGuard.mock.calls[0];
    expect(args.taskText).toBe('Primary review');
    expect(args.additionalTasks).toEqual([
      { taskText: 'Secondary review docs/specs/y.md', writeMode: 'worktree' },
    ]);
  });

  it('dispatch succeeds even when runDispatchPreconditionGuard rejects', async () => {
    mockedGuard.mockRejectedValue(new Error('guard exploded'));

    const result: any = await handleDispatchConsensus(
      [{ agent_id: 'gemini-tester', task: 'Safe consensus task' }],
    );

    await new Promise(r => setImmediate(r));

    // Handler must not throw — result envelope is present
    expect(result.content[0].text).toContain('Dispatched');
  });
});
