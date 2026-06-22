// tests/cli/orchestrator-precondition-runner.test.ts
//
// Unit tests for the UNIT 2 orchestrator precondition runner (wiring layer).
// All I/O (git, fs, emitPipelineSignals) is injected via stubs — no real
// filesystem or shell access.

import {
  gatherStaleBaseInputs,
  runDispatchPreconditionGuard,
  type PreconditionRunnerDeps,
} from '../../apps/cli/src/handlers/orchestrator-precondition-runner';
import type { PerformanceSignal } from '@gossip/orchestrator';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a minimal deps object — callers override only what they need. */
function makeDeps(overrides: Partial<PreconditionRunnerDeps> = {}): PreconditionRunnerDeps {
  return {
    execFile: jest.fn(),
    canRead: jest.fn().mockReturnValue(true),
    // Default: every referenced path exists and is tracked → no task-text signal.
    pathExists: jest.fn().mockReturnValue(true),
    isGitignoredOrUntracked: jest.fn().mockReturnValue(false),
    emitSignals: jest.fn(),
    ...overrides,
  };
}

/** Default guard input fields for the new task-text check (no referenced paths). */
const NO_TASK_TEXT = { taskText: '', writeMode: undefined as string | undefined };

// ---------------------------------------------------------------------------
// gatherStaleBaseInputs
// ---------------------------------------------------------------------------

describe('gatherStaleBaseInputs', () => {
  it('returns null when execFile throws (git unavailable)', async () => {
    const execFile = jest.fn().mockImplementation(() => { throw new Error('git not found'); });
    const result = await gatherStaleBaseInputs('/some/project', execFile);
    expect(result).toBeNull();
  });

  it('returns null when origin/master is not reachable', async () => {
    // first call (HEAD) succeeds, second (origin/master) throws
    const execFile = jest.fn()
      .mockReturnValueOnce('abc123\n')         // git rev-parse HEAD
      .mockImplementationOnce(() => { throw new Error('fatal: ambiguous argument'); });
    const result = await gatherStaleBaseInputs('/some/project', execFile);
    expect(result).toBeNull();
  });

  it('returns null when not in a git repo', async () => {
    const execFile = jest.fn().mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    const result = await gatherStaleBaseInputs('/some/project', execFile);
    expect(result).toBeNull();
  });

  it('returns trimmed SHAs on success', async () => {
    const execFile = jest.fn()
      .mockReturnValueOnce('  abc111  \n')    // HEAD
      .mockReturnValueOnce('  def222  \n')    // origin/master
      .mockReturnValueOnce('  abc111  \n');   // merge-base
    const result = await gatherStaleBaseInputs('/root', execFile);
    expect(result).toEqual({
      dispatchSha: 'abc111',
      originMasterSha: 'def222',
      mergeBaseSha: 'abc111',
    });
  });

  it('returns null mergeBaseSha when merge-base call fails but HEAD/origin succeed', async () => {
    const execFile = jest.fn()
      .mockReturnValueOnce('aaa\n')           // HEAD
      .mockReturnValueOnce('bbb\n')           // origin/master
      .mockImplementationOnce(() => { throw new Error('fatal: no merge base'); });
    const result = await gatherStaleBaseInputs('/root', execFile);
    // merge-base failure should produce null result (whole function returns null)
    expect(result).toBeNull();
  });

  it('passes cwd to execFile calls', async () => {
    const execFile = jest.fn()
      .mockReturnValueOnce('sha1\n')
      .mockReturnValueOnce('sha2\n')
      .mockReturnValueOnce('sha1\n');
    await gatherStaleBaseInputs('/my/project', execFile);
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: '/my/project' }),
    );
  });
});

// ---------------------------------------------------------------------------
// runDispatchPreconditionGuard — stale base scenarios
// ---------------------------------------------------------------------------

describe('runDispatchPreconditionGuard — stale base', () => {
  it('emits no signal and no warning when base is fresh', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('samesha\n')
        .mockReturnValueOnce('samesha\n')
        .mockReturnValueOnce('samesha\n'),
    });
    const result = await runDispatchPreconditionGuard(
      { projectRoot: '/project', taskId: 't1', resolutionRoots: [], ...NO_TASK_TEXT },
      deps,
    );
    expect(result.warnings).toHaveLength(0);
    expect(deps.emitSignals).not.toHaveBeenCalled();
  });

  it('emits dispatched_stale_base and warning when behind_origin', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('old111\n')      // HEAD
        .mockReturnValueOnce('new999\n')      // origin/master
        .mockReturnValueOnce('old111\n'),     // merge-base === HEAD → behind_origin
    });
    const result = await runDispatchPreconditionGuard(
      { projectRoot: '/project', taskId: 'task-abc', resolutionRoots: [], ...NO_TASK_TEXT },
      deps,
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/stale/i);
    expect(deps.emitSignals).toHaveBeenCalledTimes(1);
    const [, signals] = (deps.emitSignals as jest.Mock).mock.calls[0];
    expect(signals[0].signal).toBe('dispatched_stale_base');
    expect(signals[0].agentId).toBe('orchestrator');
    expect(signals[0].taskId).toBe('task-abc');
    expect(signals[0].metadata.reason).toBe('behind_origin');
  });

  it('emits dispatched_stale_base with branched_pre_merge reason', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('branchsha\n')
        .mockReturnValueOnce('mastersha\n')
        .mockReturnValueOnce('commonancestor\n'),  // different from HEAD → branched_pre_merge
    });
    const result = await runDispatchPreconditionGuard(
      { projectRoot: '/project', taskId: 'task-xyz', resolutionRoots: [], ...NO_TASK_TEXT },
      deps,
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    const [, signals] = (deps.emitSignals as jest.Mock).mock.calls[0];
    expect(signals[0].signal).toBe('dispatched_stale_base');
    expect(signals[0].metadata.reason).toBe('branched_pre_merge');
    expect(signals[0].metadata.dispatchSha).toBe('branchsha');
  });

  it('emits no stale signal when git is unavailable (null gatherStaleBaseInputs)', async () => {
    const deps = makeDeps({
      execFile: jest.fn().mockImplementation(() => {
        throw new Error('git not found');
      }),
    });
    const result = await runDispatchPreconditionGuard(
      { projectRoot: '/project', taskId: 'tX', resolutionRoots: [], ...NO_TASK_TEXT },
      deps,
    );
    expect(result.warnings).toHaveLength(0);
    // stale signal not emitted; only check no dispatched_stale_base
    const staleSignal = (deps.emitSignals as jest.Mock).mock.calls
      .flatMap(([, sigs]: [unknown, Array<{ signal: string }>]) => sigs)
      .find((s: { signal: string }) => s.signal === 'dispatched_stale_base');
    expect(staleSignal).toBeUndefined();
  });

  it('never throws even if emitSignals throws', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('old\n')
        .mockReturnValueOnce('new\n')
        .mockReturnValueOnce('old\n'),
      emitSignals: jest.fn().mockImplementation(() => { throw new Error('emit failed'); }),
    });
    await expect(
      runDispatchPreconditionGuard({ projectRoot: '/p', taskId: 't', resolutionRoots: [], ...NO_TASK_TEXT }, deps),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// runDispatchPreconditionGuard — unreadable paths
// ---------------------------------------------------------------------------

describe('runDispatchPreconditionGuard — referenced_unreadable_path', () => {
  it('emits no signal when all resolutionRoots are readable', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n'),
      canRead: jest.fn().mockReturnValue(true),
    });
    const result = await runDispatchPreconditionGuard(
      { projectRoot: '/p', taskId: 't1', resolutionRoots: ['/p/worktree1', '/p/worktree2'], ...NO_TASK_TEXT },
      deps,
    );
    expect(result.warnings).toHaveLength(0);
    const unreadableSignal = (deps.emitSignals as jest.Mock).mock.calls
      .flatMap(([, sigs]: [unknown, Array<{ signal: string }>]) => sigs)
      .find((s: { signal: string }) => s.signal === 'referenced_unreadable_path');
    expect(unreadableSignal).toBeUndefined();
  });

  it('emits signal and warning when some resolutionRoots are unreadable', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n'),
      canRead: jest.fn().mockImplementation((p: string) => p !== '/missing/path'),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 'task-123',
        resolutionRoots: ['/readable/path', '/missing/path'],
        ...NO_TASK_TEXT,
      },
      deps,
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/unreadable/i);
    expect(deps.emitSignals).toHaveBeenCalled();
    const allSignals2 = (deps.emitSignals as jest.Mock).mock.calls
      .flatMap(([, sigs]: [unknown, PerformanceSignal[]]) => sigs);
    const unreadableSignal = allSignals2.find(s => s.signal === 'referenced_unreadable_path') as PerformanceSignal & { agentId: string; taskId: string; metadata: { unreadable: string[] } } | undefined;
    expect(unreadableSignal).toBeDefined();
    expect(unreadableSignal!.agentId).toBe('orchestrator');
    expect(unreadableSignal!.taskId).toBe('task-123');
    expect(unreadableSignal!.metadata.unreadable).toEqual(['/missing/path']);
  });

  it('emits no signal when resolutionRoots is empty', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n'),
      canRead: jest.fn().mockReturnValue(false), // would fail if called
    });
    const result = await runDispatchPreconditionGuard(
      { projectRoot: '/p', taskId: 't', resolutionRoots: [], ...NO_TASK_TEXT },
      deps,
    );
    // canRead should not have been called (no paths to check)
    expect(deps.canRead).not.toHaveBeenCalled();
    const unreadableSignal = (deps.emitSignals as jest.Mock).mock.calls
      .flatMap(([, sigs]: [unknown, Array<{ signal: string }>]) => sigs)
      .find((s: { signal: string }) => s.signal === 'referenced_unreadable_path');
    expect(unreadableSignal).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });

  it('handles undefined resolutionRoots (same as empty)', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n'),
      canRead: jest.fn().mockReturnValue(false),
    });
    const result = await runDispatchPreconditionGuard(
      { projectRoot: '/p', taskId: 't', resolutionRoots: undefined, ...NO_TASK_TEXT },
      deps,
    );
    expect(deps.canRead).not.toHaveBeenCalled();
    expect(result.warnings).toHaveLength(0);
  });

  it('never throws even when canRead throws', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n')
        .mockReturnValueOnce('sha\n'),
      canRead: jest.fn().mockImplementation(() => { throw new Error('fs error'); }),
    });
    await expect(
      runDispatchPreconditionGuard(
        { projectRoot: '/p', taskId: 't', resolutionRoots: ['/some/path'], ...NO_TASK_TEXT },
        deps,
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// runDispatchPreconditionGuard — combined signals
// ---------------------------------------------------------------------------

describe('runDispatchPreconditionGuard — combined signals', () => {
  it('can emit both stale base AND unreadable paths signals in one call', async () => {
    const deps = makeDeps({
      execFile: jest.fn()
        .mockReturnValueOnce('old\n')
        .mockReturnValueOnce('new\n')
        .mockReturnValueOnce('old\n'),     // behind_origin
      canRead: jest.fn().mockReturnValue(false),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 'combined',
        resolutionRoots: ['/missing/root'],
        ...NO_TASK_TEXT,
      },
      deps,
    );
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    const allEmittedSignals = (deps.emitSignals as jest.Mock).mock.calls
      .flatMap(([, sigs]: [unknown, Array<{ signal: string }>]) => sigs)
      .map((s: { signal: string }) => s.signal);
    expect(allEmittedSignals).toContain('dispatched_stale_base');
    expect(allEmittedSignals).toContain('referenced_unreadable_path');
  });
});

// ---------------------------------------------------------------------------
// runDispatchPreconditionGuard — referenced_unreadable_path (TASK-TEXT, Bug A)
// ---------------------------------------------------------------------------

/** execFile stub that satisfies stale-base (fresh) so only the task-text path runs. */
function freshStaleExecFile(): jest.Mock {
  return jest.fn()
    .mockReturnValueOnce('sha\n')   // HEAD
    .mockReturnValueOnce('sha\n')   // origin/master
    .mockReturnValueOnce('sha\n');  // merge-base === HEAD → fresh
}

type RefSignal = PerformanceSignal & {
  agentId: string;
  taskId: string;
  metadata: { referenced: Array<{ path: string; reason: string }> };
};

function findRefSignal(emit: jest.Mock): RefSignal | undefined {
  return emit.mock.calls
    .flatMap(([, sigs]: [unknown, PerformanceSignal[]]) => sigs)
    .find((s: PerformanceSignal) => s.signal === 'referenced_unreadable_path') as RefSignal | undefined;
}

describe('runDispatchPreconditionGuard — referenced_unreadable_path (task text)', () => {
  it('emits signal + warning for a gitignored path under writeMode worktree', async () => {
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(true),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(true),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 'task-wt',
        resolutionRoots: [],
        taskText: 'Implement BUG A from spec `docs/specs/2026-06-22-fix.md` now.',
        writeMode: 'worktree',
      },
      deps,
    );
    expect(result.warnings.join(' ')).toMatch(/cannot read/i);
    const sig = findRefSignal(deps.emitSignals as jest.Mock);
    expect(sig).toBeDefined();
    expect(sig!.agentId).toBe('orchestrator');
    expect(sig!.taskId).toBe('task-wt');
    expect(sig!.metadata.referenced).toEqual([
      { path: 'docs/specs/2026-06-22-fix.md', reason: 'gitignored_in_worktree' },
    ]);
  });

  it('emits missing reason for a nonexistent referenced path (sequential mode)', async () => {
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(false),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(false),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 'task-typo',
        resolutionRoots: [],
        taskText: 'Read `docs/typo.md` and proceed.',
        writeMode: 'sequential',
      },
      deps,
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    const sig = findRefSignal(deps.emitSignals as jest.Mock);
    expect(sig!.metadata.referenced).toEqual([{ path: 'docs/typo.md', reason: 'missing' }]);
  });

  it('does NOT emit a task-text signal when the referenced path is readable', async () => {
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(true),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(false),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 't-ok',
        resolutionRoots: [],
        taskText: 'Edit `src/index.ts` carefully.',
        writeMode: 'worktree',
      },
      deps,
    );
    expect(findRefSignal(deps.emitSignals as jest.Mock)).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });

  it('does NOT flag a gitignored path under non-worktree mode (readable from root)', async () => {
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(true),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(true),
    });
    await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 't-seq',
        resolutionRoots: [],
        taskText: 'Read `docs/specs/x.md`.',
        writeMode: 'sequential',
      },
      deps,
    );
    expect(findRefSignal(deps.emitSignals as jest.Mock)).toBeUndefined();
  });

  it('never throws when pathExists predicate throws (safe default → no signal)', async () => {
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockImplementation(() => { throw new Error('fs blew up'); }),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(true),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 't-throw',
        resolutionRoots: [],
        taskText: 'Read `docs/specs/x.md`.',
        writeMode: 'worktree',
      },
      deps,
    );
    // pathExists throws → treated as "present" → no missing; gitignored check
    // still runs (returns true) → flagged gitignored_in_worktree. Key assertion:
    // the guard resolves and never throws.
    expect(result).toBeDefined();
  });

  it('never throws when isGitignoredOrUntracked predicate throws', async () => {
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(true),
      isGitignoredOrUntracked: jest.fn().mockImplementation(() => { throw new Error('git blew up'); }),
    });
    await expect(
      runDispatchPreconditionGuard(
        {
          projectRoot: '/p',
          taskId: 't-throw2',
          resolutionRoots: [],
          taskText: 'Read `docs/specs/x.md`.',
          writeMode: 'worktree',
        },
        deps,
      ),
    ).resolves.toBeDefined();
    // git predicate throws → safe default false → not flagged.
    expect(findRefSignal(deps.emitSignals as jest.Mock)).toBeUndefined();
  });

  it('emits no task-text signal when taskText is empty', async () => {
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(false),
    });
    await runDispatchPreconditionGuard(
      { projectRoot: '/p', taskId: 't', resolutionRoots: [], taskText: '', writeMode: 'worktree' },
      deps,
    );
    expect(deps.pathExists).not.toHaveBeenCalled();
    expect(findRefSignal(deps.emitSignals as jest.Mock)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runDispatchPreconditionGuard — multi-task referenced-path scan (Fix 1)
// ---------------------------------------------------------------------------

describe('runDispatchPreconditionGuard — additionalTasks (multi-task)', () => {
  it('flags a gitignored spec referenced by a worktree task at index >=1', async () => {
    // Primary task (index 0) references nothing; the SECOND task references a
    // gitignored spec under writeMode worktree. Without Fix 1 this would never
    // be flagged — the exact failure the signal exists to catch.
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(true),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(true),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 'task-multi',
        resolutionRoots: [],
        taskText: 'Primary task, no path refs here.',
        writeMode: undefined,
        additionalTasks: [
          { taskText: 'Implement from `docs/specs/2026-06-22-fix.md`.', writeMode: 'worktree' },
        ],
      },
      deps,
    );
    const sig = findRefSignal(deps.emitSignals as jest.Mock);
    expect(sig).toBeDefined();
    expect(sig!.metadata.referenced).toEqual([
      { path: 'docs/specs/2026-06-22-fix.md', reason: 'gitignored_in_worktree' },
    ]);
    expect(result.warnings.join(' ')).toMatch(/cannot read/i);
  });

  it('dedupes the same unreadable path across tasks, preferring gitignored_in_worktree', async () => {
    // Both tasks reference docs/specs/x.md. The primary (sequential) would yield
    // 'missing' if it did not exist, but here it EXISTS; the worktree task makes
    // it gitignored_in_worktree. Dedup must emit a single entry.
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      // exists everywhere → sequential task sees it as readable (no entry),
      // worktree task sees gitignored → gitignored_in_worktree.
      pathExists: jest.fn().mockReturnValue(true),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(true),
    });
    await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 'task-dedup',
        resolutionRoots: [],
        taskText: 'Read `docs/specs/x.md`.',
        writeMode: 'sequential',
        additionalTasks: [
          { taskText: 'Also read `docs/specs/x.md`.', writeMode: 'worktree' },
        ],
      },
      deps,
    );
    const sig = findRefSignal(deps.emitSignals as jest.Mock);
    expect(sig).toBeDefined();
    expect(sig!.metadata.referenced).toEqual([
      { path: 'docs/specs/x.md', reason: 'gitignored_in_worktree' },
    ]);
  });

  it('evaluates each task under its OWN writeMode (worktree-only flag does not leak to sequential task)', async () => {
    // Task A (sequential) references a.md; Task B (worktree) references b.md.
    // a.md is gitignored but readable from root → NOT flagged (sequential).
    // b.md is gitignored under worktree → flagged. Asserts per-task writeMode.
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(true),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(true),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 'task-permode',
        resolutionRoots: [],
        taskText: 'Read `a.md`.',
        writeMode: 'sequential',
        additionalTasks: [
          { taskText: 'Read `b.md`.', writeMode: 'worktree' },
        ],
      },
      deps,
    );
    const sig = findRefSignal(deps.emitSignals as jest.Mock);
    expect(sig).toBeDefined();
    expect(sig!.metadata.referenced).toEqual([
      { path: 'b.md', reason: 'gitignored_in_worktree' },
    ]);
    expect(result.warnings.join(' ')).not.toMatch(/a\.md/);
  });

  it('emits an over-cap warning when more than 20 paths are referenced (Fix 3)', async () => {
    const tokens = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
    const deps = makeDeps({
      execFile: freshStaleExecFile(),
      pathExists: jest.fn().mockReturnValue(true),
      isGitignoredOrUntracked: jest.fn().mockReturnValue(false),
    });
    const result = await runDispatchPreconditionGuard(
      {
        projectRoot: '/p',
        taskId: 'task-cap',
        resolutionRoots: [],
        taskText: `Touch these: ${tokens.join(' ')}`,
        writeMode: 'sequential',
      },
      deps,
    );
    // 5 over the cap of 20.
    expect(result.warnings.join('\n')).toMatch(/5 referenced path\(s\) beyond the 20-path cap/);
  });
});
