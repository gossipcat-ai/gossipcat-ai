/**
 * Issue #390 — dispatch-time worktree auto-discovery + soft warning.
 *
 * Mirrors the collect-time pattern at apps/cli/src/handlers/collect.ts:427.
 * Tests the two-layer behaviour:
 *
 *   Layer 1 — mode=consensus + caller didn't pass resolutionRoots + the config
 *             flag `consensus.autoDiscoverWorktrees=true` → run
 *             discoverGitWorktrees and inject results into the dispatch-time
 *             roots so per-task relay options + pendingDispatchResolutionRoots
 *             stash carry the worktree paths.
 *
 *   Layer 2 — flag is OFF, resolutionRoots is empty, worktrees exist on disk
 *             → emit a non-fatal warning in the dispatch response.
 *
 * Background: consensus 5178d3e7-41604528 on PR #389 sent gemini-tester to
 * master HEAD instead of the worktree branch because Layer 1 was missing here.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ctx } from '../../apps/cli/src/mcp-context';
import { handleDispatchConsensus } from '../../apps/cli/src/handlers/dispatch';

// Mock the orchestrator package so discoverGitWorktrees is deterministic in
// test (no real git worktree list traversal). Other named exports pass
// through to the real module so assemblePrompt / loadSkills / etc. still work.
jest.mock('@gossip/orchestrator', () => {
  const actual = jest.requireActual('@gossip/orchestrator');
  return {
    ...actual,
    discoverGitWorktrees: jest.fn(),
  };
});

import { discoverGitWorktrees } from '@gossip/orchestrator';
const mockedDiscover = discoverGitWorktrees as unknown as jest.Mock;

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
    dispatchParallel: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    getTask: jest.fn().mockReturnValue(null),
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

function resetCtx(mainAgentOverrides: Record<string, any> = {}) {
  ctx.mainAgent = makeMainAgent(mainAgentOverrides);
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

function writeConfig(dir: string, body: any): void {
  mkdirSync(join(dir, '.gossip'), { recursive: true });
  // loadConfig requires main_agent.provider + main_agent.model. Auto-discovery
  // only reads cfg.consensus.autoDiscoverWorktrees, so we merge a minimal
  // valid main_agent block with whatever the test passed in.
  const merged = {
    main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ...body,
  };
  writeFileSync(join(dir, '.gossip', 'config.json'), JSON.stringify(merged));
}

describe('handleDispatchConsensus — dispatch-time worktree auto-discovery (issue #390)', () => {
  let projectDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    projectDir = mkdtempSync(join(tmpdir(), 'gossip-dispatch-autodiscover-'));
    mkdirSync(join(projectDir, '.gossip', 'skills'), { recursive: true });
    process.chdir(projectDir);
    resetCtx();
    mockedDiscover.mockReset();

    // Register one relay agent. Relay dispatch is what reads dispatch-time
    // resolutionRoots into per-task options at dispatch.ts:911-912, so this
    // gives us the assertion surface.
    ctx.mainAgent.dispatchParallel = jest.fn().mockResolvedValue({
      taskIds: ['t-1'],
      errors: [],
    });
    ctx.mainAgent.getTask = jest.fn().mockReturnValue({ agentId: 'gemini-tester' });
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Case 1 — Layer 1 happy path: flag ON, no caller-passed roots, worktrees
  // discovered. Discovered roots must flow into both per-task relay options
  // AND ctx.pendingDispatchResolutionRoots.
  it('Layer 1 — auto-discovers worktrees and injects into relay options + stash', async () => {
    writeConfig(projectDir, { consensus: { autoDiscoverWorktrees: true } });
    mockedDiscover.mockResolvedValue({
      discovered: ['/tmp/worktree-a', '/tmp/worktree-b'],
      rejected: [],
    });

    await handleDispatchConsensus([
      { agent_id: 'gemini-tester', task: 'Audit X' },
    ]);

    expect(mockedDiscover).toHaveBeenCalledWith(expect.any(String), [expect.any(String)]);
    // Relay options carry the discovered roots
    const dispatchParallelCall = (ctx.mainAgent.dispatchParallel as jest.Mock).mock.calls[0];
    const relayDefs = dispatchParallelCall[0];
    expect(relayDefs[0].options).toEqual({
      resolutionRoots: ['/tmp/worktree-a', '/tmp/worktree-b'],
    });
    // Stash carries them too (collect-time pickup)
    expect(ctx.pendingDispatchResolutionRoots.get('t-1')).toEqual([
      '/tmp/worktree-a',
      '/tmp/worktree-b',
    ]);
  });

  // Case 2 — explicit caller-passed roots win. Auto-discovery must NOT run.
  it('Layer 1 — caller-passed resolutionRoots wins; discovery is skipped', async () => {
    writeConfig(projectDir, { consensus: { autoDiscoverWorktrees: true } });
    mockedDiscover.mockResolvedValue({
      discovered: ['/tmp/should-not-be-used'],
      rejected: [],
    });

    await handleDispatchConsensus(
      [{ agent_id: 'gemini-tester', task: 'Audit X' }],
      undefined,
      ['/tmp/explicit-root'],
    );

    expect(mockedDiscover).not.toHaveBeenCalled();
    const dispatchParallelCall = (ctx.mainAgent.dispatchParallel as jest.Mock).mock.calls[0];
    expect(dispatchParallelCall[0][0].options).toEqual({
      resolutionRoots: ['/tmp/explicit-root'],
    });
    expect(ctx.pendingDispatchResolutionRoots.get('t-1')).toEqual(['/tmp/explicit-root']);
  });

  // Case 3 — flag OFF, no worktrees on disk → no warning, no error.
  it('Layer 2 — silent when flag is off and no worktrees exist', async () => {
    writeConfig(projectDir, { consensus: { autoDiscoverWorktrees: false } });
    mockedDiscover.mockResolvedValue({ discovered: [], rejected: [] });

    const result: any = await handleDispatchConsensus([
      { agent_id: 'gemini-tester', task: 'Audit X' },
    ]);

    expect(result.warnings).toBeUndefined();
    expect(result.content[0].text).not.toContain('WARNINGS:');
  });

  // Case 4 — Layer 2 trigger: flag OFF but worktrees exist → soft warning.
  it('Layer 2 — emits soft warning when flag is off but worktrees exist', async () => {
    writeConfig(projectDir, { consensus: { autoDiscoverWorktrees: false } });
    mockedDiscover.mockResolvedValue({
      discovered: ['/tmp/orphan-worktree'],
      rejected: [],
    });

    const result: any = await handleDispatchConsensus([
      { agent_id: 'gemini-tester', task: 'Audit X' },
    ]);

    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/autoDiscoverWorktrees/);
    expect(result.warnings[0]).toMatch(/1 worktree/);
    expect(result.content[0].text).toContain('WARNINGS:');
    // F2 — WARNINGS must appear before the END sentinel so they sit inside the
    // REQUIRED_NEXT_ACTION envelope (not after the hard cut-off).
    const msgText: string = result.content[0].text;
    const warningsIdx = msgText.indexOf('WARNINGS:');
    const sentinelIdx = msgText.indexOf('=== END REQUIRED_NEXT_ACTION');
    expect(warningsIdx).toBeGreaterThanOrEqual(0);
    expect(sentinelIdx).toBeGreaterThan(warningsIdx);
    // No injection — relay options should stay empty
    const dispatchParallelCall = (ctx.mainAgent.dispatchParallel as jest.Mock).mock.calls[0];
    expect(dispatchParallelCall[0][0].options).toBeUndefined();
  });

  // Case 5 — Layer 2 silent when Layer 1 fires. Discovered roots get injected,
  // and the warning channel stays empty (operator already opted in).
  it('Layer 2 — silent when Layer 1 fires (flag on + worktrees discovered)', async () => {
    writeConfig(projectDir, { consensus: { autoDiscoverWorktrees: true } });
    mockedDiscover.mockResolvedValue({
      discovered: ['/tmp/worktree-x'],
      rejected: [],
    });

    const result: any = await handleDispatchConsensus([
      { agent_id: 'gemini-tester', task: 'Audit X' },
    ]);

    expect(result.warnings).toBeUndefined();
    const dispatchParallelCall = (ctx.mainAgent.dispatchParallel as jest.Mock).mock.calls[0];
    expect(dispatchParallelCall[0][0].options).toEqual({
      resolutionRoots: ['/tmp/worktree-x'],
    });
  });

  // Case 6 — F4: flag ON, no discovered, rejected > 0 → warning in response.
  it('F4 — emits warning when flag is on but all candidates fail validation', async () => {
    writeConfig(projectDir, { consensus: { autoDiscoverWorktrees: true } });
    mockedDiscover.mockResolvedValue({
      discovered: [],
      rejected: [{ path: '/bad/path', reason: 'not a git worktree' }],
    });

    const result: any = await handleDispatchConsensus([
      { agent_id: 'gemini-tester', task: 'Audit X' },
    ]);

    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/autoDiscoverWorktrees/);
    expect(result.warnings[0]).toMatch(/1 candidate\(s\) failed validation/);
    expect(result.warnings[0]).toMatch(/cross-review will use projectRoot only/);
    expect(result.content[0].text).toContain('WARNINGS:');
    // No roots injected — relay options should stay empty
    const dispatchParallelCall = (ctx.mainAgent.dispatchParallel as jest.Mock).mock.calls[0];
    expect(dispatchParallelCall[0][0].options).toBeUndefined();
  });

  // Case 7 — failure isolation: discoverGitWorktrees throws → dispatch still
  // succeeds with empty roots (no warning, no crash).
  it('failure isolation — dispatch succeeds when discoverGitWorktrees throws', async () => {
    writeConfig(projectDir, { consensus: { autoDiscoverWorktrees: true } });
    mockedDiscover.mockRejectedValue(new Error('git missing'));

    const result: any = await handleDispatchConsensus([
      { agent_id: 'gemini-tester', task: 'Audit X' },
    ]);

    expect(result.content).toBeDefined();
    expect(result.warnings).toBeUndefined();
    const dispatchParallelCall = (ctx.mainAgent.dispatchParallel as jest.Mock).mock.calls[0];
    expect(dispatchParallelCall[0][0].options).toBeUndefined();
    expect(ctx.pendingDispatchResolutionRoots.size).toBe(0);
  });
});
