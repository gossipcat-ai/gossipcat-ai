/**
 * handleNativeRelay isolation-warning integration test.
 *
 * Closes the test-coverage gap surfaced by consensus 68283116-20504c9d:f1
 * (MEDIUM, PR #426 review). The unit-level detector at
 * `apps/cli/src/handlers/worktree-isolation-detection.ts` is exercised by
 * `tests/cli/worktree-isolation-detection.test.ts`, but no test asserted the
 * integration into `handleNativeRelay` — a refactor of the relay handler
 * could silently disconnect the warning emission without any test failing.
 *
 * What this asserts:
 *  - When the task carries an `isolationSnapshot` and `writeMode: 'worktree'`,
 *    handleNativeRelay calls `checkIsolationViolation` and surfaces a
 *    `⚠ worktree_isolation_failed` line in the relay receipt.
 *  - When the detector reports `isViolation: false`, no warning is added.
 *  - When `isolationSnapshot` is absent, the detector is not called at all.
 */
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { handleNativeRelay } from '../../apps/cli/src/handlers/native-tasks';
import { ctx } from '../../apps/cli/src/mcp-context';

// Mock the detector module so we can deterministically return a violation diff
// without standing up a real git working tree. native-tasks.ts uses an inline
// `require('./worktree-isolation-detection')` at the call site, so this mock
// path matches the resolved module identity.
const mockCheck = jest.fn();
const mockRevert = jest.fn();
const mockPreserve = jest.fn();
jest.mock('../../apps/cli/src/handlers/worktree-isolation-detection', () => ({
  __esModule: true,
  checkIsolationViolation: (...args: any[]) => mockCheck(...args),
  revertLeakedPaths: (...args: any[]) => mockRevert(...args),
  preserveLeakedPaths: (...args: any[]) => mockPreserve(...args),
}));

const AGENT_ID = 'sonnet-implementer';
const TASK_ID = 'iso-task-1';

function makeMainAgent(projectRoot: string): any {
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
      cleanup: jest.fn().mockResolvedValue(undefined),
      pruneOrphans: jest.fn().mockResolvedValue(undefined),
    }),
    projectRoot,
  };
}

let testDir: string;
let originalCwd: string;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'gossip-relay-iso-test-'));
  originalCwd = process.cwd();
  process.chdir(testDir);

  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.recentConsensusTaskIds = new Map();
  ctx.recentConsensusAgentIds = new Map();
  ctx.mainAgent = makeMainAgent(testDir);
  ctx.nativeUtilityConfig = null;
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;

  mockCheck.mockReset();
  mockRevert.mockReset();
  mockPreserve.mockReset();
  // Default: auto-revert returns a successful no-op so existing tests that
  // trigger a violation don't blow up; tests that care assert explicitly.
  mockRevert.mockReturnValue({ restored: [], skipped: [], rejected: [] });
  // Default: preserve succeeds (patch written) so the call site proceeds to the
  // destructive revert. Tests that exercise preserve-failure override this.
  mockPreserve.mockReturnValue({
    preserved: [],
    skipped: [],
    rejected: [],
    patchPath: join(testDir, '.gossip', 'recovery', `${TASK_ID}.patch`),
  });
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
});

function seedWorktreeTask(
  taskId: string,
  agentId: string,
  opts: { withSnapshot?: boolean; concurrentWorktreeTaint?: boolean } = { withSnapshot: true },
): void {
  ctx.nativeTaskMap.set(taskId, {
    agentId,
    task: 'implement thing in worktree',
    startedAt: Date.now() - 1000,
    timeoutMs: 120_000,
    writeMode: 'worktree',
    ...(opts.concurrentWorktreeTaint !== undefined ? { concurrentWorktreeTaint: opts.concurrentWorktreeTaint } : {}),
    ...(opts.withSnapshot
      ? {
          isolationSnapshot: {
            head: 'a'.repeat(40),
            dirty: [],
            takenAt: new Date(Date.now() - 1000).toISOString(),
          },
        }
      : {}),
  });
}

describe('handleNativeRelay — worktree isolation warning integration', () => {
  it('appends ⚠ worktree_isolation_failed to receipt when detector reports a violation', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: true,
      dirtyPathsAdded: ['packages/orchestrator/src/foo.ts', 'apps/cli/src/bar.ts'],
      isViolation: true,
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    expect(mockCheck).toHaveBeenCalledTimes(1);
    const [agentArg, taskArg, snapshotArg] = mockCheck.mock.calls[0];
    expect(agentArg).toBe(AGENT_ID);
    expect(taskArg).toBe(TASK_ID);
    expect(snapshotArg).toMatchObject({ head: 'a'.repeat(40), dirty: [] });

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('⚠ worktree_isolation_failed');
    expect(text).toContain('HEAD moved');
    expect(text).toContain('2 new dirty path(s)');
    expect(text).toContain('packages/orchestrator/src/foo.ts');
    expect(text).toContain('apps/cli/src/bar.ts');
  });

  it('shows HEAD unchanged + truncated path list when >5 dirty paths reported', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'],
      isViolation: true,
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');
    const text = (res.content[0] as { text: string }).text;

    expect(text).toContain('HEAD unchanged');
    expect(text).toContain('7 new dirty path(s)');
    // First five paths listed, then +2 more truncation marker
    expect(text).toContain('a.ts, b.ts, c.ts, d.ts, e.ts');
    expect(text).toContain('+2 more');
    expect(text).not.toContain('g.ts'); // truncated past the 5-path window
  });

  it('omits warning when detector reports isViolation: false', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: [],
      isViolation: false,
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    expect(mockCheck).toHaveBeenCalledTimes(1);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('worktree_isolation_failed');
  });

  it('does not invoke detector when isolationSnapshot is absent', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID, { withSnapshot: false });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    expect(mockCheck).not.toHaveBeenCalled();
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('worktree_isolation_failed');
  });

  it('does not invoke detector for non-worktree writeMode', async () => {
    // scoped writeMode + isolationSnapshot present (defensive — should still not call)
    ctx.nativeTaskMap.set(TASK_ID, {
      agentId: AGENT_ID,
      task: 'scoped task',
      startedAt: Date.now() - 1000,
      timeoutMs: 120_000,
      writeMode: 'scoped',
      isolationSnapshot: {
        head: 'b'.repeat(40),
        dirty: [],
        takenAt: new Date().toISOString(),
      },
    });

    await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('still emits warning when detector throws (caller swallows + isolationDiff stays null → no warning)', async () => {
    // The handler wraps checkIsolationViolation in try/catch; a throw should
    // leave isolationDiff null, and the warning block should be skipped.
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockImplementation(() => { throw new Error('detector blew up'); });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('worktree_isolation_failed');
  });

  // ─── Option A auto-revert (design consensus c15cb1d8-c66840b7) ─────────────

  it('auto-recovers leaked paths via revertLeakedPaths on non-tainted violation', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['apps/cli/src/leaked.ts', 'packages/x/y.ts'],
      isViolation: true,
    });
    mockRevert.mockReturnValue({
      restored: ['apps/cli/src/leaked.ts', 'packages/x/y.ts'],
      skipped: [],
      rejected: [],
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    expect(mockRevert).toHaveBeenCalledTimes(1);
    const [revertCwd, revertPaths] = mockRevert.mock.calls[0];
    expect(revertCwd).toBe(testDir);
    expect(revertPaths).toEqual(['apps/cli/src/leaked.ts', 'packages/x/y.ts']);

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('⚠ worktree_isolation_failed');
    expect(text).toContain('leaked work preserved at .gossip/recovery/iso-task-1.patch');
    expect(text).toContain('master restored (2 path(s))');
  });

  it('reports skipped-path count in receipt when some paths no longer exist', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['exists.ts', 'gone.ts'],
      isViolation: true,
    });
    mockRevert.mockReturnValue({
      restored: ['exists.ts'],
      skipped: ['gone.ts'],
      rejected: [],
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('master restored (1 path(s))');
    expect(text).toContain('1 path(s) skipped');
  });

  it('reports rejected-path count in receipt when defense-in-depth filter blocked entries', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['ok.ts', '/etc/passwd'],
      isViolation: true,
    });
    mockRevert.mockReturnValue({
      restored: ['ok.ts'],
      skipped: [],
      rejected: ['/etc/passwd'],
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('master restored (1 path(s))');
    expect(text).toContain('1 path(s) rejected — security filter');
  });

  it('reports master restore FAILED in receipt (work still preserved) without throwing when revertLeakedPaths reports an error', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['weird.ts'],
      isViolation: true,
    });
    mockRevert.mockReturnValue({
      restored: [],
      skipped: [],
      rejected: [],
      error: 'fatal: pathspec did not match any file',
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('⚠ worktree_isolation_failed');
    expect(text).toContain('leaked work preserved at .gossip/recovery/iso-task-1.patch');
    expect(text).toContain('master restore FAILED');
    expect(text).toContain('pathspec did not match');
    expect(text).toContain("Run 'git restore <paths>' manually");
  });

  it('reports auto-recovery FAILED in receipt when revertLeakedPaths itself throws', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['x.ts'],
      isViolation: true,
    });
    mockRevert.mockImplementation(() => { throw new Error('require crashed'); });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('⚠ worktree_isolation_failed');
    expect(text).toContain('auto-recovery FAILED');
    expect(text).toContain('require crashed');
  });

  it('does NOT auto-recover when concurrencyTainted=true (attribution ambiguous)', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID, { withSnapshot: true, concurrentWorktreeTaint: true });
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['foo.ts', 'bar.ts'],
      isViolation: true,
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    expect(mockRevert).not.toHaveBeenCalled();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('worktree_isolation_skipped');
    expect(text).not.toContain('auto-recovered');
    expect(text).not.toContain('auto-recovery FAILED');
  });

  it('does NOT auto-recover when dirtyPathsAdded is empty (HEAD-drift-only violation)', async () => {
    seedWorktreeTask(TASK_ID, AGENT_ID);
    mockCheck.mockReturnValue({
      headChanged: true,
      dirtyPathsAdded: [],
      isViolation: true,
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    expect(mockRevert).not.toHaveBeenCalled();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('worktree_isolation_failed');
    expect(text).not.toContain('auto-recovered');
  });

  it('routes to worktree_isolation_skipped when task has concurrentWorktreeTaint=true', async () => {
    // Seed task with the taint flag manually (stamping path tested separately in
    // dispatch-concurrency-taint.test.ts). We only need the relay handler path here.
    seedWorktreeTask(TASK_ID, AGENT_ID, { withSnapshot: true, concurrentWorktreeTaint: true });
    mockCheck.mockReturnValue({
      headChanged: false,
      dirtyPathsAdded: ['packages/orchestrator/src/foo.ts'],
      isViolation: true,
    });

    const res = await handleNativeRelay(TASK_ID, '<agent_finding type="finding" severity="LOW">x</agent_finding>');

    const text = (res.content[0] as { text: string }).text;
    // Receipt must say skipped, not failed
    expect(text).toContain('worktree_isolation_skipped');
    expect(text).not.toContain('worktree_isolation_failed');

    // relay-warnings.jsonl must have a structured entry with reason: 'worktree_isolation_skipped'
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const warningsPath = join(testDir, '.gossip', 'relay-warnings.jsonl');
    const raw = readFileSync(warningsPath, 'utf8').trim();
    const lines = raw.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Find the skipped entry — there may be other warning lines (relay lint etc.)
    const skippedEntry = lines
      .map((l: string) => JSON.parse(l))
      .find((e: any) => e.reason === 'worktree_isolation_skipped');
    expect(skippedEntry).toBeDefined();
    expect(skippedEntry.taskId).toBe(TASK_ID);
    expect(skippedEntry.agentId).toBe(AGENT_ID);
    expect(skippedEntry.reason).toBe('worktree_isolation_skipped');
  });
});
