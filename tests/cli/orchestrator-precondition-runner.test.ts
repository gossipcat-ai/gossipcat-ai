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
import { resetBaseRefDiscoveryCache } from '../../apps/cli/src/handlers/base-ref-discovery';
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

type ExecFileArg = string | Error | undefined;

/**
 * Args-matching execFile stub covering both base-ref discovery calls
 * (symbolic-ref, rev-parse --verify --quiet) and the three stale-base git
 * calls (rev-parse HEAD, rev-parse <ref>, merge-base HEAD <ref>).
 *
 * By default `origin/HEAD` is unset (symbolic-ref throws, the realistic CI
 * shallow-clone case) and `origin/master` resolves — matching this repo's
 * actual default branch — so existing "fresh" / "behind_origin" /
 * "branched_pre_merge" test intent carries over unchanged. Override any leg
 * to test a different discovery path (e.g. verifyMaster: undefined,
 * verifyMain: 'ok' to exercise the origin/main fallback).
 */
function makeExecFile(overrides: {
  head?: ExecFileArg;
  origin?: ExecFileArg;
  mergeBase?: ExecFileArg;
  symbolicRef?: ExecFileArg;
  verifyMaster?: ExecFileArg;
  verifyMain?: ExecFileArg;
  ref?: string; // the ref name used in the 'rev-parse <ref>' / 'merge-base HEAD <ref>' calls
} = {}): jest.Mock {
  const ref = overrides.ref ?? 'origin/master';
  const verifyMaster = 'verifyMaster' in overrides ? overrides.verifyMaster : 'origin/master-exists';
  return jest.fn().mockImplementation((_cmd: string, args: string[]) => {
    const key = args.join(' ');

    const resolve = (v: ExecFileArg, unexpectedLabel: string): string => {
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`unexpected git call: ${unexpectedLabel}`);
      return v;
    };

    if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
      if (overrides.symbolicRef instanceof Error) throw overrides.symbolicRef;
      if (overrides.symbolicRef === undefined) {
        throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
      }
      return overrides.symbolicRef;
    }
    if (key === 'rev-parse --verify --quiet origin/master') {
      if (verifyMaster instanceof Error) throw verifyMaster;
      if (verifyMaster === undefined) throw new Error('fatal: ambiguous argument \'origin/master\'');
      return verifyMaster;
    }
    if (key === 'rev-parse --verify --quiet origin/main') {
      if (overrides.verifyMain instanceof Error) throw overrides.verifyMain;
      if (overrides.verifyMain === undefined) throw new Error('fatal: ambiguous argument \'origin/main\'');
      return overrides.verifyMain;
    }
    if (key === 'remote') return 'origin\n';
    if (key === 'rev-parse HEAD') return resolve(overrides.head, 'rev-parse HEAD');
    if (key === `rev-parse ${ref}`) return resolve(overrides.origin, `rev-parse ${ref}`);
    if (key === `merge-base HEAD ${ref}`) return resolve(overrides.mergeBase, `merge-base HEAD ${ref}`);

    throw new Error(`unexpected git call: ${key}`);
  });
}

/** execFile stub that satisfies stale-base (fresh) so only the task-text path runs. */
function freshStaleExecFile(): jest.Mock {
  return makeExecFile({ head: 'sha\n', origin: 'sha\n', mergeBase: 'sha\n' });
}

beforeEach(() => {
  resetBaseRefDiscoveryCache();
});

// ---------------------------------------------------------------------------
// gatherStaleBaseInputs
// ---------------------------------------------------------------------------

describe('gatherStaleBaseInputs', () => {
  it('returns null when execFile throws (git unavailable)', async () => {
    const execFile = jest.fn().mockImplementation(() => { throw new Error('git not found'); });
    const result = await gatherStaleBaseInputs('/some/project', execFile);
    expect(result).toBeNull();
  });

  it('returns null when no base ref resolves (origin/master, origin/main both unreachable)', async () => {
    const execFile = makeExecFile({ verifyMaster: undefined, verifyMain: undefined });
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
    const execFile = makeExecFile({
      head: '  abc111  \n',
      origin: '  def222  \n',
      mergeBase: '  abc111  \n',
    });
    const result = await gatherStaleBaseInputs('/root', execFile);
    expect(result).toEqual({
      dispatchSha: 'abc111',
      originMasterSha: 'def222',
      mergeBaseSha: 'abc111',
      baseRef: 'origin/master',
    });
  });

  it('returns null mergeBaseSha when merge-base call fails but HEAD/origin succeed', async () => {
    const execFile = makeExecFile({
      head: 'aaa\n',
      origin: 'bbb\n',
      mergeBase: new Error('fatal: no merge base'),
    });
    const result = await gatherStaleBaseInputs('/root', execFile);
    // merge-base failure should produce null result (whole function returns null)
    expect(result).toBeNull();
  });

  it('passes cwd to execFile calls', async () => {
    const execFile = makeExecFile({ head: 'sha1\n', origin: 'sha2\n', mergeBase: 'sha1\n' });
    await gatherStaleBaseInputs('/my/project', execFile);
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: '/my/project' }),
    );
  });

  it('resolves via origin/main fallback when origin/master does not exist', async () => {
    const execFile = makeExecFile({
      ref: 'origin/main',
      verifyMaster: undefined,
      verifyMain: 'origin/main-exists',
      head: 'h1\n',
      origin: 'o1\n',
      mergeBase: 'h1\n',
    });
    const result = await gatherStaleBaseInputs('/root', execFile);
    expect(result).toEqual({
      dispatchSha: 'h1',
      originMasterSha: 'o1',
      mergeBaseSha: 'h1',
      baseRef: 'origin/main',
    });
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'origin/main'],
      expect.objectContaining({ cwd: '/root' }),
    );
  });

  it('honors GOSSIP_BASE_REF override end to end', async () => {
    const prev = process.env.GOSSIP_BASE_REF;
    process.env.GOSSIP_BASE_REF = 'upstream/develop';
    try {
      const execFile = jest.fn().mockImplementation((_cmd: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'rev-parse HEAD') return 'h9\n';
        if (key === 'rev-parse upstream/develop') return 'o9\n';
        if (key === 'merge-base HEAD upstream/develop') return 'h9\n';
        // The override is validated before use: it must resolve and be
        // remote-tracking (a local branch would make the direct-push detector
        // flag an innocent agent).
        if (key === 'rev-parse --verify --quiet upstream/develop') return 'o9\n';
        if (key === 'rev-parse --symbolic-full-name upstream/develop') return 'refs/remotes/upstream/develop\n';
        throw new Error(`unexpected git call: ${key}`);
      });
      const result = await gatherStaleBaseInputs('/root', execFile);
      expect(result).toEqual({
        dispatchSha: 'h9',
        originMasterSha: 'o9',
        mergeBaseSha: 'h9',
        baseRef: 'upstream/develop',
      });
      // Override skips symbolic-ref discovery — it only validates itself.
      expect(execFile).not.toHaveBeenCalledWith('git', expect.arrayContaining(['symbolic-ref']), expect.anything());
    } finally {
      if (prev === undefined) delete process.env.GOSSIP_BASE_REF;
      else process.env.GOSSIP_BASE_REF = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// runDispatchPreconditionGuard — stale base scenarios
// ---------------------------------------------------------------------------

describe('runDispatchPreconditionGuard — stale base', () => {
  it('emits no signal and no warning when base is fresh', async () => {
    const deps = makeDeps({
      execFile: makeExecFile({ head: 'samesha\n', origin: 'samesha\n', mergeBase: 'samesha\n' }),
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
      execFile: makeExecFile({
        head: 'old111\n',       // HEAD
        origin: 'new999\n',     // origin/master
        mergeBase: 'old111\n',  // merge-base === HEAD → behind_origin
      }),
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
      execFile: makeExecFile({
        head: 'branchsha\n',
        origin: 'mastersha\n',
        mergeBase: 'commonancestor\n', // different from HEAD → branched_pre_merge
      }),
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

  it('emits NO dispatched_stale_base signal when branch is strictly ahead of origin (ahead_of_origin)', async () => {
    const deps = makeDeps({
      execFile: makeExecFile({
        head: 'feature-tip\n',    // HEAD
        origin: 'origin-head\n',  // origin/master
        mergeBase: 'origin-head\n', // merge-base === origin → strictly ahead
      }),
    });
    const result = await runDispatchPreconditionGuard(
      { projectRoot: '/project', taskId: 'task-fwd', resolutionRoots: [], ...NO_TASK_TEXT },
      deps,
    );
    // Branch strictly ahead of origin is NOT stale — no signal, no warning
    expect(result.warnings).toHaveLength(0);
    const staleSignal = (deps.emitSignals as jest.Mock).mock.calls
      .flatMap(([, sigs]: [unknown, Array<{ signal: string }>]) => sigs)
      .find((s: { signal: string }) => s.signal === 'dispatched_stale_base');
    expect(staleSignal).toBeUndefined();
  });

  it('never throws even if emitSignals throws', async () => {
    const deps = makeDeps({
      execFile: makeExecFile({ head: 'old\n', origin: 'new\n', mergeBase: 'old\n' }),
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
      execFile: freshStaleExecFile(),
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
      execFile: freshStaleExecFile(),
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
      execFile: freshStaleExecFile(),
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
      execFile: freshStaleExecFile(),
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
      execFile: freshStaleExecFile(),
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
      execFile: makeExecFile({ head: 'old\n', origin: 'new\n', mergeBase: 'old\n' }), // behind_origin
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
