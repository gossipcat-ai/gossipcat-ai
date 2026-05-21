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
