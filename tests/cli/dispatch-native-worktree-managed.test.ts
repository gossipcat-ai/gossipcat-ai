/**
 * Tests for Option A — structural fix for native Agent(isolation:"worktree")
 * dispatch (spec: docs/specs/2026-05-20-native-worktree-isolation-fix.md §3).
 *
 * Contracts asserted:
 *  1. ENV-GATE: with GOSSIP_NATIVE_WORKTREE_MANAGED unset (or != "1"),
 *     dispatch behavior is byte-identical to the pre-PR path — no cd line
 *     in Item 1, no worktreePath persisted on the task record,
 *     WorktreeManager.create() not invoked.
 *  2. MANAGED MODE: with the env var set, dispatch.ts pre-creates the
 *     worktree via WorktreeManager.create(taskId), persists the absolute
 *     path on the NativeTaskInfo entry, and injects `Step 0 — cd <path>` as
 *     a prefix of the Item 1 orchestrator instructions.
 *  3. HANDBOOK invariant #4: the cd line is in Item 1 ONLY — Item 2
 *     (verbatim AGENT_PROMPT) MUST NOT contain it, otherwise modern Sonnet
 *     reads orchestration leakage as credential injection and refuses.
 *  4. ELIDED FORMAT: the on-disk prompt file at .gossip/dispatch-prompts/
 *     <taskId>.txt MUST NOT contain the cd line under prompt_format='elided'
 *     — the cd line still belongs ONLY in the Item 1 marker block.
 */

import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ctx } from '../../apps/cli/src/mcp-context';
import { handleDispatchSingle } from '../../apps/cli/src/handlers/dispatch';

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
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
  ctx.syncWorkersViaKeychain = jest.fn().mockResolvedValue(undefined) as any;
  (ctx as any).skillEngine = null;
}

function restoreCtx() {
  Object.assign(ctx, originalCtx);
}

/**
 * Initialize a minimal git repo so `git rev-parse --git-dir` succeeds in
 * handleDispatchSingle's useWorktree guard. WorktreeManager.create() is
 * mocked separately on the mainAgent stub — we do not exercise the real
 * git-worktree machinery here.
 */
function initGitRepo(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  execSync('git commit --allow-empty -q -m init', { cwd: dir });
}

function findItem1(content: Array<{ text: string }>): string {
  // Item 1 is the orchestrator-instruction banner (content[0]).
  return content[0].text;
}

function findAgentPromptItem(content: Array<{ text: string }>): string | null {
  const m = content.find(c => c.text.startsWith('AGENT_PROMPT:'));
  return m ? m.text : null;
}

describe('native dispatch — Option A managed worktree (GOSSIP_NATIVE_WORKTREE_MANAGED)', () => {
  let workDir: string;
  let prevCwd: string;
  let prevEnv: string | undefined;
  let createMock: jest.Mock;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevEnv = process.env.GOSSIP_NATIVE_WORKTREE_MANAGED;
    workDir = mkdtempSync(join(tmpdir(), 'gossip-native-managed-wt-'));
    mkdirSync(join(workDir, '.gossip', 'skills'), { recursive: true });
    initGitRepo(workDir);
    process.chdir(workDir);

    createMock = jest.fn().mockResolvedValue({
      path: '/tmp/managed-wt-abc12345',
      branch: 'gossip-task-stub',
    });

    resetCtx({
      getWorktreeManager: jest.fn().mockReturnValue({
        create: createMock,
        cleanup: jest.fn().mockResolvedValue(undefined),
        pruneOrphans: jest.fn().mockResolvedValue(undefined),
      }),
    });

    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-sonnet-4-6',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
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

  describe('ENV-GATE — env var unset / != "1"', () => {
    it('does NOT call WorktreeManager.create() when env var is unset', async () => {
      delete process.env.GOSSIP_NATIVE_WORKTREE_MANAGED;
      const res = await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      expect(createMock).not.toHaveBeenCalled();
      const item1 = findItem1(res.content);
      expect(item1).not.toMatch(/Step 0 — chdir/);
      expect(item1).not.toMatch(/^cd /m);
    });

    it('does NOT call WorktreeManager.create() when env var is "0"', async () => {
      process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = '0';
      const res = await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      expect(createMock).not.toHaveBeenCalled();
      expect(findItem1(res.content)).not.toMatch(/Step 0 — chdir/);
    });

    it('does NOT call WorktreeManager.create() when write_mode != "worktree"', async () => {
      process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = '1';
      const res = await handleDispatchSingle('native-claude', 'audit x', 'sequential');
      expect(createMock).not.toHaveBeenCalled();
      expect(findItem1(res.content)).not.toMatch(/Step 0 — chdir/);
    });

    it('does NOT persist worktreePath on the task record when env var is unset', async () => {
      delete process.env.GOSSIP_NATIVE_WORKTREE_MANAGED;
      await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      // task IDs are randomUUID().slice(0, 8) — pick the only entry.
      const entries = [...ctx.nativeTaskMap.entries()];
      expect(entries.length).toBe(1);
      const [, info] = entries[0];
      expect(info.worktreePath).toBeUndefined();
    });
  });

  describe('MANAGED MODE — env var = "1"', () => {
    beforeEach(() => {
      process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = '1';
    });

    it('calls WorktreeManager.create() exactly once with the taskId', async () => {
      await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      expect(createMock).toHaveBeenCalledTimes(1);
      const [arg] = createMock.mock.calls[0];
      // taskId is randomUUID().slice(0, 8) — 8 hex chars
      expect(typeof arg).toBe('string');
      expect(arg).toMatch(/^[0-9a-f-]{6,}$/i);
    });

    it('persists the worktreePath on the NativeTaskInfo entry', async () => {
      await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      const entries = [...ctx.nativeTaskMap.entries()];
      expect(entries.length).toBe(1);
      const [, info] = entries[0];
      expect(info.worktreePath).toBe('/tmp/managed-wt-abc12345');
    });

    it('injects "Step 0 — cd <managed-path>" into Item 1', async () => {
      const res = await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      const item1 = findItem1(res.content);
      expect(item1).toMatch(/Step 0 — chdir into the gossipcat-managed worktree/);
      expect(item1).toMatch(/cd '\/tmp\/managed-wt-abc12345'/);
      // Step 0 must precede Step 1
      const step0 = item1.indexOf('Step 0');
      const step1 = item1.indexOf('Step 1');
      expect(step0).toBeGreaterThan(-1);
      expect(step1).toBeGreaterThan(step0);
    });

    it('does NOT inject cd line into Item 2 (AGENT_PROMPT) — HANDBOOK invariant #4', async () => {
      const res = await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      const agentPrompt = findAgentPromptItem(res.content);
      expect(agentPrompt).not.toBeNull();
      expect(agentPrompt!).not.toMatch(/cd '\/tmp\/managed-wt-abc12345'/);
      expect(agentPrompt!).not.toMatch(/Step 0 — chdir/);
      // Sanity: AGENT_PROMPT still starts with its tag — no orchestration prefix
      expect(agentPrompt!.startsWith('AGENT_PROMPT:')).toBe(true);
    });

    it('retains the isolation:"worktree" flag in the Agent() call (belt-and-suspenders)', async () => {
      const res = await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      const item1 = findItem1(res.content);
      expect(item1).toMatch(/isolation: "worktree"/);
    });

    it('falls back gracefully when WorktreeManager.create() throws', async () => {
      createMock.mockRejectedValueOnce(new Error('git not happy'));
      const res = await handleDispatchSingle('native-claude', 'audit x', 'worktree');
      // Dispatch must still succeed — fallback to legacy harness-managed path.
      expect(createMock).toHaveBeenCalledTimes(1);
      const item1 = findItem1(res.content);
      expect(item1).not.toMatch(/Step 0 — chdir/); // no cd injected when create failed
      expect(item1).toMatch(/isolation: "worktree"/); // legacy isolation flag preserved
      const entries = [...ctx.nativeTaskMap.entries()];
      const [, info] = entries[0];
      expect(info.worktreePath).toBeUndefined();
    });

    it('does NOT call create() when write_mode is not worktree even if env var is set', async () => {
      await handleDispatchSingle('native-claude', 'audit x', 'sequential');
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe('ELIDED FORMAT — on-disk prompt file MUST NOT carry the cd line', () => {
    beforeEach(() => {
      process.env.GOSSIP_NATIVE_WORKTREE_MANAGED = '1';
    });

    it('does NOT write the cd line into .gossip/dispatch-prompts/<taskId>.txt', async () => {
      const res = await handleDispatchSingle(
        'native-claude',
        'audit x',
        'worktree',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'elided',
      );
      // Find the elision marker in Item 1 — extract the on-disk path it cites.
      const item1 = findItem1(res.content);
      expect(item1).toMatch(/skills section elided/);
      const m = item1.match(/elided: see ([^,]+),/);
      expect(m).not.toBeNull();
      const onDiskPath = m![1];
      expect(existsSync(onDiskPath)).toBe(true);
      const body = readFileSync(onDiskPath, 'utf8');
      // Iron-rule: agent-facing prompt file MUST NOT contain orchestration text.
      expect(body).not.toMatch(/cd '\/tmp\/managed-wt-abc12345'/);
      expect(body).not.toMatch(/Step 0 — chdir/);
      // But Item 1 STILL emits the cd line for the orchestrator.
      expect(item1).toMatch(/cd '\/tmp\/managed-wt-abc12345'/);
    });

    it('under elision, Item 2 is ABSENT (spec §2) — no AGENT_PROMPT content item', async () => {
      const res = await handleDispatchSingle(
        'native-claude',
        'audit x',
        'worktree',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'elided',
      );
      // content[0] = Item 1 banner; no second AGENT_PROMPT item under elision.
      expect(findAgentPromptItem(res.content)).toBeNull();
    });
  });
});
