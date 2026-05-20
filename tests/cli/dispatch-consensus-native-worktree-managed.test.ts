/**
 * Tests for Option A — structural fix extended to handleDispatchConsensus
 * (spec: docs/specs/2026-05-20-native-worktree-isolation-fix.md §3, consensus-
 * path requirement from the implementer task brief).
 *
 * Consensus task defs do not carry write_mode (cross-review is uniform), so
 * the gate is GOSSIP_NATIVE_WORKTREE_MANAGED=1 alone. When the gate is on:
 *   - Each native consensus reviewer gets its own gossipcat-managed worktree.
 *   - The cd line is injected into the orchestrator instruction banner only.
 *   - isolation:"worktree" is added belt-and-suspenders (legacy consensus
 *     emits no isolation flag).
 *   - Per-task create() failure falls back to the legacy path for that task.
 *   - The on-disk elided prompt file MUST NOT contain the cd line.
 */

import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ctx } from '../../apps/cli/src/mcp-context';
import { handleDispatchConsensus } from '../../apps/cli/src/handlers/dispatch';

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

function initGitRepo(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  execSync('git commit --allow-empty -q -m init', { cwd: dir });
}

function getBanner(content: Array<{ text: string }>): string {
  return content[0].text;
}
function getAgentPromptItems(content: Array<{ text: string }>): string[] {
  return content.filter(c => c.text.startsWith('AGENT_PROMPT:')).map(c => c.text);
}

describe('consensus dispatch — Option A managed worktree (GOSSIP_NATIVE_WORKTREE_MANAGED)', () => {
  let workDir: string;
  let prevCwd: string;
  let prevEnv: string | undefined;
  let createMock: jest.Mock;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevEnv = process.env.GOSSIP_NATIVE_WORKTREE_MANAGED;
    workDir = mkdtempSync(join(tmpdir(), 'gossip-consensus-managed-wt-'));
    mkdirSync(join(workDir, '.gossip', 'skills'), { recursive: true });
    initGitRepo(workDir);
    process.chdir(workDir);

    let n = 0;
    createMock = jest.fn().mockImplementation(async (taskId: string) => ({
      path: `/tmp/managed-wt-${taskId}-${n++}`,
      branch: `gossip-task-${taskId}`,
    }));

    resetCtx({
      getWorktreeManager: jest.fn().mockReturnValue({
        create: createMock,
        cleanup: jest.fn().mockResolvedValue(undefined),
        pruneOrphans: jest.fn().mockResolvedValue(undefined),
      }),
    });

    ctx.nativeAgentConfigs.set('native-r1', {
      model: 'claude-sonnet-4-6',
      instructions: 'Reviewer 1',
      description: 'r1',
      skills: [],
    });
    ctx.nativeAgentConfigs.set('native-r2', {
      model: 'claude-sonnet-4-6',
      instructions: 'Reviewer 2',
      description: 'r2',
      skills: [],
    });
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(workDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.GOSSIP_NATIVE_WORKTREE_MANAGED;
    else process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = prevEnv;
  });

  describe('ENV-GATE — env var unset', () => {
    it('does NOT call WorktreeManager.create() and emits no cd line', async () => {
      delete process.env.GOSSIP_NATIVE_WORKTREE_MANAGED;
      const res = await handleDispatchConsensus([
        { agent_id: 'native-r1', task: 'review x' },
        { agent_id: 'native-r2', task: 'review x' },
      ]);
      expect(createMock).not.toHaveBeenCalled();
      const banner = getBanner(res.content);
      expect(banner).not.toMatch(/Step 0 — chdir/);
      // Legacy consensus behavior: no isolation flag emitted
      expect(banner).not.toMatch(/isolation: "worktree"/);
    });

    it('does NOT call create() when env var is "0"', async () => {
      process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = '0';
      await handleDispatchConsensus([
        { agent_id: 'native-r1', task: 'review x' },
        { agent_id: 'native-r2', task: 'review x' },
      ]);
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe('MANAGED MODE — env var = "1"', () => {
    beforeEach(() => {
      process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = '1';
    });

    it('calls WorktreeManager.create() per native consensus task', async () => {
      await handleDispatchConsensus([
        { agent_id: 'native-r1', task: 'review x' },
        { agent_id: 'native-r2', task: 'review x' },
      ]);
      expect(createMock).toHaveBeenCalledTimes(2);
      const taskIds = createMock.mock.calls.map(c => c[0]);
      expect(new Set(taskIds).size).toBe(2);
    });

    it('persists worktreePath on each NativeTaskInfo entry', async () => {
      await handleDispatchConsensus([
        { agent_id: 'native-r1', task: 'review x' },
        { agent_id: 'native-r2', task: 'review x' },
      ]);
      const infos = [...ctx.nativeTaskMap.values()];
      expect(infos.length).toBe(2);
      for (const info of infos) {
        expect(info.worktreePath).toMatch(/^\/tmp\/managed-wt-/);
      }
      const paths = new Set(infos.map(i => i.worktreePath));
      expect(paths.size).toBe(2);
    });

    it('injects Step 0 — cd <path> per task in the orchestrator banner', async () => {
      const res = await handleDispatchConsensus([
        { agent_id: 'native-r1', task: 'review x' },
        { agent_id: 'native-r2', task: 'review x' },
      ]);
      const banner = getBanner(res.content);
      const cdMatches = banner.match(/Step 0 — chdir into the gossipcat-managed worktree/g);
      expect(cdMatches).not.toBeNull();
      expect(cdMatches!.length).toBe(2);
      const pathMatches = banner.match(/cd '\/tmp\/managed-wt-[^']+'/g);
      expect(pathMatches).not.toBeNull();
      expect(pathMatches!.length).toBe(2);
    });

    it('adds isolation:"worktree" belt-and-suspenders flag on each task', async () => {
      const res = await handleDispatchConsensus([
        { agent_id: 'native-r1', task: 'review x' },
        { agent_id: 'native-r2', task: 'review x' },
      ]);
      const banner = getBanner(res.content);
      const m = banner.match(/isolation: "worktree"/g);
      expect(m).not.toBeNull();
      expect(m!.length).toBe(2);
    });

    it('does NOT inject cd line into per-task AGENT_PROMPT items — HANDBOOK invariant #4', async () => {
      const res = await handleDispatchConsensus([
        { agent_id: 'native-r1', task: 'review x' },
        { agent_id: 'native-r2', task: 'review x' },
      ]);
      const prompts = getAgentPromptItems(res.content);
      expect(prompts.length).toBe(2);
      for (const p of prompts) {
        expect(p).not.toMatch(/cd '\/tmp\/managed-wt-/);
        expect(p).not.toMatch(/Step 0 — chdir/);
        expect(p.startsWith('AGENT_PROMPT:')).toBe(true);
      }
    });

    it('partial failure: one create() throws, sibling proceeds; failing task falls back', async () => {
      createMock
        .mockRejectedValueOnce(new Error('git not happy'))
        .mockResolvedValueOnce({ path: '/tmp/managed-wt-survivor', branch: 'b' });
      const res = await handleDispatchConsensus([
        { agent_id: 'native-r1', task: 'review x' },
        { agent_id: 'native-r2', task: 'review x' },
      ]);
      expect(createMock).toHaveBeenCalledTimes(2);
      const banner = getBanner(res.content);
      const cdMatches = banner.match(/Step 0 — chdir/g);
      expect(cdMatches).not.toBeNull();
      expect(cdMatches!.length).toBe(1);
      expect(banner).toMatch(/cd '\/tmp\/managed-wt-survivor'/);
      // Only the survivor gets isolation:"worktree" too (failing task falls
      // back to legacy consensus path — no isolation flag, matching pre-PR).
      const isolationMatches = banner.match(/isolation: "worktree"/g);
      expect(isolationMatches).not.toBeNull();
      expect(isolationMatches!.length).toBe(1);
      const infos = [...ctx.nativeTaskMap.values()];
      const withPath = infos.filter(i => !!i.worktreePath);
      expect(withPath.length).toBe(1);
      expect(withPath[0].worktreePath).toBe('/tmp/managed-wt-survivor');
    });

    it('does NOT write cd line into elided on-disk prompt files', async () => {
      const res = await handleDispatchConsensus(
        [
          { agent_id: 'native-r1', task: 'review x' },
          { agent_id: 'native-r2', task: 'review x' },
        ],
        undefined,
        undefined,
        'elided',
      );
      const banner = getBanner(res.content);
      const matches = [...banner.matchAll(/elided: see ([^,]+),/g)];
      expect(matches.length).toBe(2);
      for (const m of matches) {
        const onDiskPath = m[1];
        expect(existsSync(onDiskPath)).toBe(true);
        const body = readFileSync(onDiskPath, 'utf8');
        expect(body).not.toMatch(/cd '\/tmp\/managed-wt-/);
        expect(body).not.toMatch(/Step 0 — chdir/);
      }
      // Item 2 ABSENT under elision — no per-task AGENT_PROMPT items
      expect(getAgentPromptItems(res.content).length).toBe(0);
    });
  });
});
