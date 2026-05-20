/**
 * Tests for Option A — structural fix extended to handleDispatchParallel
 * (spec: docs/specs/2026-05-20-native-worktree-isolation-fix.md §3, parallel-
 * path requirement from the implementer task brief).
 *
 * Mirrors dispatch-native-worktree-managed.test.ts (single-dispatch path):
 *  1. ENV-GATE: with GOSSIP_NATIVE_WORKTREE_MANAGED unset, parallel dispatch
 *     does NOT call WorktreeManager.create() and emits no cd line.
 *  2. MANAGED MODE: with env var set, EACH native worktree-mode task gets its
 *     own WorktreeManager.create() call and absolute path; the per-task cd
 *     line lands ONLY in the orchestrator-instruction text, never the
 *     per-task AGENT_PROMPT content item.
 *  3. PARTIAL FAILURE: if create() throws for one task, the sibling task
 *     proceeds and the failing task falls back to the legacy harness path.
 *  4. ELIDED FORMAT: the on-disk prompt file MUST NOT contain the cd line.
 */

import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ctx } from '../../apps/cli/src/mcp-context';
import { handleDispatchParallel } from '../../apps/cli/src/handlers/dispatch';

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

describe('parallel dispatch — Option A managed worktree (GOSSIP_NATIVE_WORKTREE_MANAGED)', () => {
  let workDir: string;
  let prevCwd: string;
  let prevEnv: string | undefined;
  let createMock: jest.Mock;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevEnv = process.env.GOSSIP_NATIVE_WORKTREE_MANAGED;
    workDir = mkdtempSync(join(tmpdir(), 'gossip-parallel-managed-wt-'));
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

    ctx.nativeAgentConfigs.set('native-a', {
      model: 'claude-sonnet-4-6',
      instructions: 'A',
      description: 'A',
      skills: [],
    });
    ctx.nativeAgentConfigs.set('native-b', {
      model: 'claude-sonnet-4-6',
      instructions: 'B',
      description: 'B',
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
      const res = await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'audit x', write_mode: 'worktree' },
          { agent_id: 'native-b', task: 'audit y', write_mode: 'worktree' },
        ],
        false,
      );
      expect(createMock).not.toHaveBeenCalled();
      const banner = getBanner(res.content);
      expect(banner).not.toMatch(/Step 0 — chdir/);
    });

    it('does NOT call create() when write_mode != worktree even with env var set', async () => {
      process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = '1';
      await handleDispatchParallel(
        [{ agent_id: 'native-a', task: 'audit x', write_mode: 'sequential' }],
        false,
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe('MANAGED MODE — env var = "1"', () => {
    beforeEach(() => {
      process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = '1';
    });

    it('calls WorktreeManager.create() per worktree-mode task', async () => {
      await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'audit x', write_mode: 'worktree' },
          { agent_id: 'native-b', task: 'audit y', write_mode: 'worktree' },
        ],
        false,
      );
      expect(createMock).toHaveBeenCalledTimes(2);
      // Each invocation receives a distinct 8-char taskId
      const taskIds = createMock.mock.calls.map(c => c[0]);
      expect(new Set(taskIds).size).toBe(2);
      for (const tid of taskIds) {
        expect(typeof tid).toBe('string');
        expect(tid).toMatch(/^[0-9a-f-]{6,}$/i);
      }
    });

    it('persists worktreePath on each NativeTaskInfo entry', async () => {
      await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'audit x', write_mode: 'worktree' },
          { agent_id: 'native-b', task: 'audit y', write_mode: 'worktree' },
        ],
        false,
      );
      const infos = [...ctx.nativeTaskMap.values()];
      expect(infos.length).toBe(2);
      for (const info of infos) {
        expect(info.worktreePath).toMatch(/^\/tmp\/managed-wt-/);
      }
      // Distinct paths per task
      const paths = new Set(infos.map(i => i.worktreePath));
      expect(paths.size).toBe(2);
    });

    it('injects "Step 0 — cd <managed-path>" for each task in the banner', async () => {
      const res = await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'audit x', write_mode: 'worktree' },
          { agent_id: 'native-b', task: 'audit y', write_mode: 'worktree' },
        ],
        false,
      );
      const banner = getBanner(res.content);
      const cdMatches = banner.match(/Step 0 — chdir into the gossipcat-managed worktree/g);
      expect(cdMatches).not.toBeNull();
      expect(cdMatches!.length).toBe(2);
      // Both managed paths appear
      const pathMatches = banner.match(/cd '\/tmp\/managed-wt-[^']+'/g);
      expect(pathMatches).not.toBeNull();
      expect(pathMatches!.length).toBe(2);
    });

    it('preserves isolation:"worktree" flag on each worktree task (belt-and-suspenders)', async () => {
      const res = await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'audit x', write_mode: 'worktree' },
          { agent_id: 'native-b', task: 'audit y', write_mode: 'worktree' },
        ],
        false,
      );
      const banner = getBanner(res.content);
      const isolationMatches = banner.match(/isolation: "worktree"/g);
      expect(isolationMatches).not.toBeNull();
      expect(isolationMatches!.length).toBe(2);
    });

    it('does NOT inject cd line into per-task AGENT_PROMPT items — HANDBOOK invariant #4', async () => {
      const res = await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'audit x', write_mode: 'worktree' },
          { agent_id: 'native-b', task: 'audit y', write_mode: 'worktree' },
        ],
        false,
      );
      const prompts = getAgentPromptItems(res.content);
      expect(prompts.length).toBe(2);
      for (const p of prompts) {
        expect(p).not.toMatch(/cd '\/tmp\/managed-wt-/);
        expect(p).not.toMatch(/Step 0 — chdir/);
        expect(p.startsWith('AGENT_PROMPT:')).toBe(true);
      }
    });

    it('partial failure: one create() throws, sibling proceeds with managed path; failing task falls back', async () => {
      createMock
        .mockRejectedValueOnce(new Error('git not happy'))
        .mockResolvedValueOnce({ path: '/tmp/managed-wt-survivor', branch: 'b' });
      const res = await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'audit x', write_mode: 'worktree' },
          { agent_id: 'native-b', task: 'audit y', write_mode: 'worktree' },
        ],
        false,
      );
      expect(createMock).toHaveBeenCalledTimes(2);
      const banner = getBanner(res.content);
      // Exactly one Step 0 — the survivor
      const cdMatches = banner.match(/Step 0 — chdir/g);
      expect(cdMatches).not.toBeNull();
      expect(cdMatches!.length).toBe(1);
      expect(banner).toMatch(/cd '\/tmp\/managed-wt-survivor'/);
      // worktreePath populated on exactly one of the two task entries
      const infos = [...ctx.nativeTaskMap.values()];
      const withPath = infos.filter(i => !!i.worktreePath);
      expect(withPath.length).toBe(1);
      expect(withPath[0].worktreePath).toBe('/tmp/managed-wt-survivor');
    });

    it('does NOT write cd line into elided on-disk prompt files', async () => {
      const res = await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'audit x', write_mode: 'worktree' },
          { agent_id: 'native-b', task: 'audit y', write_mode: 'worktree' },
        ],
        false,
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
      // Item 2 ABSENT under elision — no AGENT_PROMPT content items
      expect(getAgentPromptItems(res.content).length).toBe(0);
    });
  });
});
