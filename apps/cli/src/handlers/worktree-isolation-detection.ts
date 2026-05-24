// @gossip:impact-adjacent:signal-pipeline

/**
 * Native worktree isolation detection — Option B (detection-only safety net).
 *
 * Spec: docs/specs/2026-05-20-native-worktree-isolation-fix.md §"Option B"
 *
 * Agent(isolation:"worktree") native dispatches occasionally land writes in the
 * parent checkout instead of the requested .claude/worktrees/<id>/ sandbox
 * (e.g. PR #422). This module captures a snapshot of parent-checkout state at
 * dispatch time (HEAD SHA + `git status --porcelain` paths) and re-checks on
 * relay completion. If EITHER HEAD moved OR new dirty paths appeared that
 * weren't in the snapshot, emit a `worktree_isolation_failed` operational
 * signal so the failure is auditable.
 *
 * IMPORTANT: HEAD-drift alone wouldn't have caught PR #422 (clean fork case);
 * the working-tree dirty diff is the canonical detector.
 *
 * Fail-open everywhere — detection MUST NOT block a real relay completion.
 */
import { execFileSync } from 'child_process';

export interface IsolationSnapshot {
  /** HEAD SHA of parent checkout at dispatch time, or null on git failure. */
  head: string | null;
  /**
   * Sorted list of `path` portions from `git status --porcelain`. Each entry
   * is the raw path string (porcelain v1 columns 3+). Stored sorted so set
   * diffs are stable across runs.
   */
  dirty: string[];
  /** ISO timestamp of when the snapshot was taken. */
  takenAt: string;
}

/** Parsed diff between two snapshots. */
export interface IsolationDiff {
  headChanged: boolean;
  dirtyPathsAdded: string[];
  isViolation: boolean;
}

/** Read `git rev-parse HEAD` from `cwd`. Returns null on any failure. */
function readHead(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Parse `git status --porcelain` into a sorted list of path strings.
 *
 * Porcelain v1 format per line: `XY <path>` where XY is a 2-char status code
 * and `<path>` extends to end-of-line (renames use `orig -> new`, we keep the
 * raw line content after the leading 3 chars for diff stability).
 */
export function parsePorcelain(output: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
  const paths: string[] = [];
  for (const line of lines) {
    // porcelain v1: 2-char XY, 1 space, then path. Length < 4 → malformed, skip.
    if (line.length < 4) continue;
    const path = line.slice(3);
    if (path) paths.push(path);
  }
  return paths.sort();
}

/**
 * SAFE_NAME for taskId-as-filename — alphanumerics plus `._-`, no `..`
 * substring, 1-64 chars. Mirrors the `SAFE_TASK_ID` regex in
 * `dispatch-prompt-storage.ts` (which writes `.gossip/dispatch-prompts/<taskId>.txt`)
 * so the recovery-patch path uses the identical validation contract. Re-declared
 * locally to avoid a cross-module import and keep this detector self-contained.
 */
const SAFE_TASK_ID = /^(?!.*\.\.)[A-Za-z0-9._-]{1,64}$/;

/**
 * Shared defence-in-depth path filter used by BOTH `revertLeakedPaths` and
 * `preserveLeakedPaths` so the two helpers cannot drift. Rejects absolute paths
 * and leading-dash args (the latter would be parsed as git flags despite the
 * `--` separator in some shells). The `--` separator passed to execFileSync is
 * the real guard against git-flag-injection; this filter exists so a rejected
 * path is auditable in the receipt rather than vanishing silently.
 *
 * Note: `../` traversal is NOT filtered here — git resolves it relative to cwd,
 * and dirtyPathsAdded from `git status --porcelain` never contains it.
 */
export function filterSafePaths(paths: string[]): { safe: string[]; rejected: string[] } {
  const safe: string[] = [];
  const rejected: string[] = [];
  if (!paths) return { safe, rejected };
  for (const p of paths) {
    if (typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.startsWith('-')) {
      safe.push(p);
    } else if (typeof p === 'string' && p.length > 0) {
      rejected.push(p);
    }
  }
  return { safe, rejected };
}

/** Result of an auto-revert attempt — surfaced in the relay receipt. */
export interface IsolationRevertResult {
  /** Paths actually restored to HEAD content. */
  restored: string[];
  /** Paths that were skipped because the file no longer exists on disk. */
  skipped: string[];
  /** Paths rejected by the defense-in-depth filter (absolute / leading-dash). */
  rejected: string[];
  /** Set when `git restore` itself failed; receipt should display this message. */
  error?: string;
}

/**
 * Auto-revert leaked paths via `git restore --source=HEAD -- <paths>`.
 *
 * Design consensus c15cb1d8-c66840b7: when checkIsolationViolation reports a
 * leak AND the violation is not concurrency-tainted, restore the leaked paths
 * from HEAD so the parent checkout is recovered automatically.
 *
 * - Skips files that no longer exist on disk (rename / delete races) so a
 *   single missing path doesn't fail the whole batch.
 * - Quiet on success: git restore inherits no stdio.
 * - Fail-open: any throw is caught and surfaced through `error`; callers
 *   continue rendering the relay receipt.
 *
 * Paths are passed to git via `--` to disarm any leading dashes; absolute
 * paths are filtered out as a defence-in-depth measure since dirtyPathsAdded
 * normally comes from `git status --porcelain` (always repo-relative).
 */
export function revertLeakedPaths(
  cwd: string,
  paths: string[],
): IsolationRevertResult {
  const result: IsolationRevertResult = { restored: [], skipped: [], rejected: [] };
  if (!paths || paths.length === 0) return result;

  // Defence-in-depth: filter absolute paths and leading-dash args via the shared
  // `filterSafePaths` (also used by preserveLeakedPaths so they cannot drift).
  // The `--` separator in execFileSync (below) is the real guard against
  // git-flag-injection; this filter exists so a rejected path is auditable in
  // the receipt rather than vanishing silently.
  const { safe: safePaths, rejected } = filterSafePaths(paths);
  result.rejected = rejected;

  // Skip paths that no longer exist on disk (rename / delete races). All entries
  // in safePaths are repo-relative after the filter above, so path.join(cwd, p)
  // is the only resolution mode needed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const present: string[] = [];
  for (const p of safePaths) {
    const abs = path.join(cwd, p);
    if (fs.existsSync(abs)) {
      present.push(p);
    } else {
      result.skipped.push(p);
    }
  }

  if (present.length === 0) return result;

  try {
    execFileSync('git', ['restore', '--source=HEAD', '--', ...present], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    result.restored = present;
  } catch (err) {
    result.error = (err as Error).message || String(err);
  }
  return result;
}

/** Result of a non-destructive preserve attempt — surfaced in the relay receipt. */
export interface IsolationPreserveResult {
  /** Absolute path to the written patch, set only when a patch was captured. */
  patchPath?: string;
  /** Paths actually included in the captured patch. */
  preserved: string[];
  /** Paths skipped because the file no longer exists on disk. */
  skipped: string[];
  /** Paths rejected by the shared safety filter (absolute / leading-dash). */
  rejected: string[];
  /** Set on any git/IO failure — caller must NOT proceed to destructive revert. */
  error?: string;
}

/**
 * Non-destructive companion to `revertLeakedPaths`: capture the leaked work to a
 * recoverable patch BEFORE master is cleaned, so an isolation escape no longer
 * destroys the agent's changes.
 *
 * Spec: docs/specs/2026-05-24-worktree-isolation-nondestructive-recovery.md §3.1.
 *
 * Sequence (the patch must cover BOTH tracked-modified AND untracked-new files;
 * plain `git diff` omits untracked files):
 *   1. `git add -N -- <present safe paths>` — intent-to-add so new files appear
 *      in the diff as additions without staging their content.
 *   2. `git diff -- <present safe paths>` → atomic temp+rename into
 *      `.gossip/recovery/<SAFE taskId>.patch`.
 *   3. `git reset -- <present safe paths>` — undo the intent-to-add so the
 *      working tree is byte-identical to before this call. CRITICAL: the
 *      subsequent `revertLeakedPaths` must behave exactly as it does today.
 *
 * Fail-open: any git/IO error returns `{ error }` and never throws. Per spec
 * §3.1(b) the caller skips the destructive revert when this returns an error
 * (or writes no patch), so work is never destroyed when the safety net failed.
 */
export function preserveLeakedPaths(
  cwd: string,
  paths: string[],
  taskId: string,
): IsolationPreserveResult {
  const result: IsolationPreserveResult = { preserved: [], skipped: [], rejected: [] };
  if (!paths || paths.length === 0) return result;

  // Validate taskId before it touches the filesystem as a filename. Same guard
  // contract as .gossip/dispatch-prompts/<taskId>.txt (dispatch-prompt-storage.ts).
  if (typeof taskId !== 'string' || !SAFE_TASK_ID.test(taskId)) {
    result.error = `taskId failed SAFE_NAME validation (rejected: ${JSON.stringify(taskId).slice(0, 64)})`;
    return result;
  }

  // Shared safety filter — identical to revertLeakedPaths so they cannot drift.
  const { safe: safePaths, rejected } = filterSafePaths(paths);
  result.rejected = rejected;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto');

  // Skip paths that no longer exist on disk (rename / delete races). Mirrors
  // revertLeakedPaths so the two helpers operate on the same `present` set.
  const present: string[] = [];
  for (const p of safePaths) {
    if (fs.existsSync(path.join(cwd, p))) {
      present.push(p);
    } else {
      result.skipped.push(p);
    }
  }

  if (present.length === 0) return result;

  try {
    // 1. intent-to-add so untracked-new files surface in the diff as additions
    //    without their content entering the index.
    execFileSync('git', ['add', '-N', '--', ...present], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    let diff: Buffer;
    try {
      // 2. capture the unified patch (tracked-modified + intent-to-add new files).
      diff = execFileSync('git', ['diff', '--', ...present], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } finally {
      // 3. ALWAYS undo the intent-to-add, even if `git diff` threw — the working
      //    tree (and index) must be byte-identical to before this call so the
      //    subsequent revertLeakedPaths behaves exactly as today.
      try {
        execFileSync('git', ['reset', '--', ...present], {
          cwd,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        // best-effort. `git reset` of intent-to-add entries is near-infallible,
        // but if it DID fail the captured patch is still valid (diff ran before
        // this reset), so work is preserved — the only residue is intent-to-add
        // entries left in the index (surfacing as empty new files in
        // `git status`), recoverable with `git reset HEAD -- <paths>`. We do not
        // fail the preserve for this: the patch (the thing that matters) is intact.
      }
    }

    const recoveryDir = path.join(cwd, '.gossip', 'recovery');
    fs.mkdirSync(recoveryDir, { recursive: true });
    const finalPath = path.join(recoveryDir, `${taskId}.patch`);
    const tmpPath = path.join(recoveryDir, `${taskId}.patch.${crypto.randomUUID().slice(0, 8)}.tmp`);
    try {
      fs.writeFileSync(tmpPath, diff);
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      throw err;
    }

    result.patchPath = finalPath;
    result.preserved = present;
  } catch (err) {
    result.error = (err as Error).message || String(err);
  }
  return result;
}

/** Run `git status --porcelain` from `cwd`. Returns [] on any failure. */
function readPorcelain(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return parsePorcelain(out);
  } catch {
    return [];
  }
}

/**
 * Capture parent-checkout state at dispatch time. Called from dispatch.ts
 * BEFORE Agent(isolation:"worktree") is invoked; only for writeMode === 'worktree'.
 *
 * Both probes fail-open: on git error, head stays null and dirty stays [] —
 * the diff function gracefully degrades (a null `before.head` short-circuits
 * the HEAD-drift check; an empty `before.dirty` means every observed dirty
 * path on relay counts as "added").
 */
export function captureIsolationSnapshot(cwd: string = process.cwd()): IsolationSnapshot {
  return {
    head: readHead(cwd),
    dirty: readPorcelain(cwd),
    takenAt: new Date().toISOString(),
  };
}

/**
 * Diff two snapshots. Violation if HEAD moved OR new dirty paths appeared
 * that weren't in the `before` set.
 *
 * `before.head === null` short-circuits the HEAD comparison — we can't claim
 * drift if we never read the baseline. The dirty-path diff still runs and is
 * sufficient to catch the PR #422 pattern (HEAD untouched, files written
 * directly to parent checkout).
 */
export function diffIsolationSnapshots(
  before: IsolationSnapshot,
  after: IsolationSnapshot,
): IsolationDiff {
  const headChanged =
    before.head !== null && after.head !== null && before.head !== after.head;

  const beforeSet = new Set(before.dirty);
  const dirtyPathsAdded = after.dirty.filter(p => !beforeSet.has(p));

  return {
    headChanged,
    dirtyPathsAdded,
    isViolation: headChanged || dirtyPathsAdded.length > 0,
  };
}

/** Build the operational-signal payload for a detected isolation failure. */
export function buildIsolationSignal(args: {
  agentId: string;
  taskId: string;
  before: IsolationSnapshot;
  after: IsolationSnapshot;
  diff: IsolationDiff;
}): {
  type: 'consensus';
  signal: 'worktree_isolation_failed';
  agentId: string;
  taskId: string;
  evidence: string;
  timestamp: string;
  head_before: string | null;
  head_after: string | null;
  dirty_paths_added: string[];
} {
  const { agentId, taskId, before, after, diff } = args;
  const headSummary = diff.headChanged
    ? `HEAD ${before.head?.slice(0, 8) ?? 'null'}→${after.head?.slice(0, 8) ?? 'null'}`
    : 'HEAD unchanged';
  const dirtySummary = diff.dirtyPathsAdded.length > 0
    ? `${diff.dirtyPathsAdded.length} new dirty path(s)`
    : 'no new dirty paths';
  return {
    type: 'consensus',
    signal: 'worktree_isolation_failed',
    agentId,
    taskId,
    evidence: `Agent(isolation:"worktree") write leaked into parent checkout: ${headSummary}, ${dirtySummary}`,
    timestamp: new Date().toISOString(),
    head_before: before.head,
    head_after: after.head,
    dirty_paths_added: diff.dirtyPathsAdded,
  };
}

/**
 * End-to-end check called from native-tasks.handleNativeRelay. Re-runs the
 * probes, diffs against the dispatch-time snapshot, and emits the signal if
 * a violation is detected. Returns the diff so the caller can surface a
 * warning in the relay receipt.
 *
 * @param concurrencyTainted - When `true`, this task's lifetime overlapped
 *   with at least one other worktree-mode task at dispatch time. Attribution
 *   is ambiguous — skip emitConsensusSignals and emit a skipped breadcrumb
 *   instead. `false` or `undefined` preserves existing emit behaviour.
 *
 * Fail-open: any throw is swallowed; returns a no-violation diff.
 */
export function checkIsolationViolation(
  agentId: string,
  taskId: string,
  before: IsolationSnapshot,
  cwd: string = process.cwd(),
  concurrencyTainted?: boolean,
): IsolationDiff {
  try {
    const after = captureIsolationSnapshot(cwd);
    const diff = diffIsolationSnapshots(before, after);
    if (diff.isViolation) {
      if (concurrencyTainted === true) {
        // Lifetime overlapped with another worktree task — attribution is
        // ambiguous; skip signal emission and emit a breadcrumb only.
        try {
          process.stderr.write(
            `[gossipcat] ⚠️  worktree_isolation_skipped [${taskId}] agent=${agentId} ` +
            `dirtyAdded=${diff.dirtyPathsAdded.length} concurrency_tainted=true — ` +
            `lifetime overlapped with another worktree task at dispatch time; attribution ambiguous\n`,
          );
        } catch { /* best-effort */ }
      } else {
        try {
          const { emitConsensusSignals } = require('@gossip/orchestrator');
          emitConsensusSignals(cwd, [buildIsolationSignal({ agentId, taskId, before, after, diff })]);
        } catch {
          /* best-effort — signal emission must not block relay completion */
        }
        try {
          const list = diff.dirtyPathsAdded.slice(0, 5).join(', ');
          const more = diff.dirtyPathsAdded.length > 5 ? ` +${diff.dirtyPathsAdded.length - 5} more` : '';
          process.stderr.write(
            `[gossipcat] ⚠️  worktree_isolation_failed [${taskId}] agent=${agentId} ` +
            `headChanged=${diff.headChanged} dirtyAdded=${diff.dirtyPathsAdded.length}${list ? ` (${list}${more})` : ''}\n`,
          );
        } catch { /* best-effort */ }
      }
    }
    return diff;
  } catch {
    return { headChanged: false, dirtyPathsAdded: [], isViolation: false };
  }
}
