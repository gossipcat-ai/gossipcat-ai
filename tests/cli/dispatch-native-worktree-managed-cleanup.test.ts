/**
 * Per-task cleanup for managed-worktree mode in handleNativeRelay.
 *
 * Spec: PR post-#431 cleanup contract (dispatch-native-worktree-managed-cleanup.test.ts).
 *
 * Contracts asserted:
 *  1. MANAGED SUCCESS: when taskInfo.worktreePath is defined and relay succeeds,
 *     wtm.cleanup(taskId, worktreePath) is called exactly once — no pruneOrphans.
 *  2. MANAGED ERROR: when taskInfo.worktreePath is defined and relay errors,
 *     wtm.cleanup(taskId, worktreePath) is called exactly once — no pruneOrphans.
 *  3. LEGACY ERROR: when taskInfo.worktreePath is undefined and relay errors,
 *     wtm.pruneOrphans() is called exactly once — cleanup() is NOT called.
 *  4. LEGACY SUCCESS: when taskInfo.worktreePath is undefined and relay succeeds,
 *     neither cleanup() nor pruneOrphans() is called.
 *  5. NON-WORKTREE: when writeMode is not 'worktree', no cleanup is triggered
 *     regardless of worktreePath presence.
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { handleNativeRelay } from '../../apps/cli/src/handlers/native-tasks';
import { ctx } from '../../apps/cli/src/mcp-context';

const AGENT_ID = 'sonnet-implementer';
const TASK_ID = 'wt-cleanup-task-1';
const MANAGED_WT_PATH = '/tmp/gossip-wt-managed-abc12345';

// Mock modules used by handleNativeRelay internals so they don't require
// real git repos or live signal pipelines.
jest.mock('../../apps/cli/src/handlers/worktree-isolation-detection', () => ({
  __esModule: true,
  checkIsolationViolation: jest.fn().mockReturnValue({ headChanged: false, dirtyPathsAdded: [], isViolation: false }),
}));

jest.mock('../../apps/cli/src/handlers/ref-allowlist-detection', () => ({
  __esModule: true,
  checkRefAllowlistViolation: jest.fn(),
}));

let cleanupMock: jest.Mock;
let pruneOrphansMock: jest.Mock;

function makeMainAgent(): any {
  cleanupMock = jest.fn().mockResolvedValue(undefined);
  pruneOrphansMock = jest.fn().mockResolvedValue(undefined);
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'mock' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null),
    getLLM: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]),
    getSessionGossip: jest.fn().mockReturnValue([]),
    getPerfReader: jest.fn().mockReturnValue(undefined),
    recordNativeTask: jest.fn(),
    recordNativeTaskCompleted: jest.fn(),
    recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined),
    scopeTracker: { release: jest.fn() },
    getWorktreeManager: jest.fn().mockReturnValue({
      cleanup: cleanupMock,
      pruneOrphans: pruneOrphansMock,
    }),
    projectRoot: '/tmp/gossip-test-project',
  };
}

let testDir: string;
let originalCwd: string;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'gossip-wt-cleanup-test-'));
  originalCwd = process.cwd();
  process.chdir(testDir);

  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.nativeUtilityResultMap = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.recentConsensusTaskIds = new Map();
  ctx.recentConsensusAgentIds = new Map();
  ctx.mainAgent = makeMainAgent();
  ctx.nativeUtilityConfig = null;
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;

  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * Seed nativeTaskMap with a worktree-mode task.
 * worktreePath is set only when managed=true (mirrors how dispatch.ts writes it).
 */
function seedWorktreeTask(
  taskId: string,
  opts: { managed?: boolean; writeMode?: string } = {},
): void {
  const { managed = false, writeMode = 'worktree' } = opts;
  ctx.nativeTaskMap.set(taskId, {
    agentId: AGENT_ID,
    task: 'implement thing in worktree',
    startedAt: Date.now() - 1000,
    timeoutMs: 120_000,
    writeMode: writeMode as any,
    ...(managed ? { worktreePath: MANAGED_WT_PATH } : {}),
  });
}

const VALID_RESULT = '<agent_finding type="finding" severity="low">x</agent_finding>';

describe('handleNativeRelay — managed-worktree per-task cleanup', () => {
  describe('MANAGED MODE (worktreePath defined)', () => {
    it('calls cleanup(taskId, worktreePath) on SUCCESS — not pruneOrphans', async () => {
      seedWorktreeTask(TASK_ID, { managed: true });

      await handleNativeRelay(TASK_ID, VALID_RESULT);

      // Allow one tick for fire-and-forget promise to flush
      await new Promise(resolve => setImmediate(resolve));

      expect(cleanupMock).toHaveBeenCalledTimes(1);
      expect(cleanupMock).toHaveBeenCalledWith(TASK_ID, MANAGED_WT_PATH);
      expect(pruneOrphansMock).not.toHaveBeenCalled();
    });

    it('calls cleanup(taskId, worktreePath) on ERROR — not pruneOrphans', async () => {
      seedWorktreeTask(TASK_ID, { managed: true });

      await handleNativeRelay(TASK_ID, '', 'agent failed with exit code 1');

      await new Promise(resolve => setImmediate(resolve));

      expect(cleanupMock).toHaveBeenCalledTimes(1);
      expect(cleanupMock).toHaveBeenCalledWith(TASK_ID, MANAGED_WT_PATH);
      expect(pruneOrphansMock).not.toHaveBeenCalled();
    });

    it('does not throw when cleanup() rejects (fire-and-forget contract)', async () => {
      seedWorktreeTask(TASK_ID, { managed: true });
      cleanupMock.mockRejectedValueOnce(new Error('git worktree remove failed'));

      // Must not throw
      await expect(handleNativeRelay(TASK_ID, VALID_RESULT)).resolves.not.toThrow();
      await new Promise(resolve => setImmediate(resolve));
    });
  });

  describe('LEGACY MODE (worktreePath undefined)', () => {
    it('calls pruneOrphans() on ERROR — not cleanup()', async () => {
      seedWorktreeTask(TASK_ID, { managed: false });

      await handleNativeRelay(TASK_ID, '', 'agent errored');

      await new Promise(resolve => setImmediate(resolve));

      expect(pruneOrphansMock).toHaveBeenCalledTimes(1);
      expect(cleanupMock).not.toHaveBeenCalled();
    });

    it('calls NEITHER cleanup() NOR pruneOrphans() on SUCCESS', async () => {
      seedWorktreeTask(TASK_ID, { managed: false });

      await handleNativeRelay(TASK_ID, VALID_RESULT);

      await new Promise(resolve => setImmediate(resolve));

      expect(cleanupMock).not.toHaveBeenCalled();
      expect(pruneOrphansMock).not.toHaveBeenCalled();
    });
  });

  describe('DEFENSIVE EDGES (consensus cb4e7421-6a2e4128)', () => {
    it('does not throw when getWorktreeManager() returns undefined (managed task)', async () => {
      seedWorktreeTask(TASK_ID, { managed: true });
      (ctx.mainAgent.getWorktreeManager as jest.Mock).mockReturnValueOnce(undefined);

      // wtm?.cleanup()?.catch() must short-circuit on undefined wtm,
      // not throw TypeError on the .catch call.
      await expect(handleNativeRelay(TASK_ID, VALID_RESULT)).resolves.not.toThrow();
      await new Promise(resolve => setImmediate(resolve));

      expect(cleanupMock).not.toHaveBeenCalled();
      expect(pruneOrphansMock).not.toHaveBeenCalled();
    });

    it('treats empty-string worktreePath identically to undefined (falsy guard)', async () => {
      // Direct seed with worktreePath: '' (bypasses seedWorktreeTask's helper).
      ctx.nativeTaskMap.set(TASK_ID, {
        agentId: AGENT_ID,
        task: 'implement thing',
        startedAt: Date.now() - 1000,
        timeoutMs: 120_000,
        writeMode: 'worktree' as any,
        worktreePath: '',
      });

      await handleNativeRelay(TASK_ID, '', 'agent errored');
      await new Promise(resolve => setImmediate(resolve));

      // Empty string is falsy → takes the legacy branch → pruneOrphans on error
      expect(cleanupMock).not.toHaveBeenCalled();
      expect(pruneOrphansMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('NON-WORKTREE writeMode', () => {
    it('does not call cleanup() or pruneOrphans() for scoped write mode', async () => {
      seedWorktreeTask(TASK_ID, { managed: true, writeMode: 'scoped' });

      await handleNativeRelay(TASK_ID, '', 'agent errored');

      await new Promise(resolve => setImmediate(resolve));

      expect(cleanupMock).not.toHaveBeenCalled();
      expect(pruneOrphansMock).not.toHaveBeenCalled();
    });

    it('does not call cleanup() or pruneOrphans() for sequential write mode', async () => {
      seedWorktreeTask(TASK_ID, { managed: false, writeMode: 'sequential' });

      await handleNativeRelay(TASK_ID, VALID_RESULT);

      await new Promise(resolve => setImmediate(resolve));

      expect(cleanupMock).not.toHaveBeenCalled();
      expect(pruneOrphansMock).not.toHaveBeenCalled();
    });
  });
});
