/**
 * orchestrator-precondition-runner.ts
 *
 * UNIT 2: Wiring layer for the orchestrator signal pipeline pre-dispatch guard.
 * Runs git-based stale-base detection and path-readability checks, then emits
 * operational pipeline signals against agentId:'orchestrator'.
 *
 * Design rules:
 *   - NEVER throw into callers — every I/O boundary is wrapped in try/catch.
 *   - All git/fs/emit collaborators are injected via `deps` for testability.
 *   - Signal names used here are already registered in consensus-types.ts;
 *     do NOT re-add them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  detectStaleBase,
  findUnreadablePaths,
  findUnreadableReferencedPathsWithMeta,
  detectMidFlightCommits,
} from '@gossip/orchestrator';
import type { UnreadableReferencedPath } from '@gossip/orchestrator';
import type { PerformanceSignal } from '@gossip/orchestrator';
// FIX 6: static import to ensure esbuild bundles emitPipelineSignals.
// Dynamic import() is NOT bundled in esbuild single-file builds — this was the
// root cause of the activity-mirror hooks silently no-op'ing (project_activity_mirror_v2_progress).
import { emitPipelineSignals as staticEmitPipelineSignals } from '@gossip/orchestrator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected collaborators — all optional, defaulting to real I/O impls. */
export interface PreconditionRunnerDeps {
  /**
   * Synchronous git invocation (signature matches execFileSync).
   * Receives (cmd, args, options) — options includes { cwd, encoding }.
   * Must return the stdout string or throw on failure.
   */
  execFile: (cmd: string, args: string[], opts: { cwd: string; encoding: 'utf8' }) => string;
  /** Returns true when the given path is readable by the current process. */
  canRead: (p: string) => boolean;
  /**
   * Returns true when the referenced repo-relative path exists / is readable at
   * the project root. Injected so the task-text check is unit-testable without
   * touching the filesystem.
   */
  pathExists: (projectRoot: string, p: string) => boolean;
  /**
   * Returns true when the repo-relative path is gitignored OR untracked (i.e.
   * absent from a fresh worktree checkout). Injected for testability.
   */
  isGitignoredOrUntracked: (projectRoot: string, p: string, execFile: PreconditionRunnerDeps['execFile']) => boolean;
  /**
   * Best-effort pipeline signal emitter.
   * Signature mirrors emitPipelineSignals(projectRoot, signals).
   */
  emitSignals: (projectRoot: string, signals: PerformanceSignal[]) => void;
}

/** Injected collaborators for the mid-flight fixup detector (UNIT 3). */
export interface MidFlightCheckDeps {
  /**
   * Synchronous git invocation — same signature as PreconditionRunnerDeps.execFile.
   * Only needs to support `git log <sha>..HEAD --format=%H`.
   */
  execFile: (cmd: string, args: string[], opts: { cwd: string; encoding: 'utf8' }) => string;
  /**
   * Best-effort pipeline signal emitter.
   * Signature mirrors emitPipelineSignals(projectRoot, signals).
   */
  emitSignals: (projectRoot: string, signals: PerformanceSignal[]) => void;
}

export interface MidFlightCheckInput {
  projectRoot: string;
  consensusId: string;
  /** HEAD SHA captured at round-registration time; falsy → no-op. */
  roundStartSha: string | undefined;
}

export interface MidFlightCheckResult {
  warnings: string[];
}

export interface StaleBaseInputs {
  dispatchSha: string;
  originMasterSha: string;
  mergeBaseSha: string | null;
}

export interface PreconditionGuardAdditionalTask {
  /** A non-primary task's body — scanned for referenced repo-relative paths. */
  taskText: string;
  /** That task's own effective write mode (gitignored_in_worktree is per-task). */
  writeMode?: string;
}

export interface PreconditionGuardInput {
  projectRoot: string;
  taskId: string;
  resolutionRoots: readonly string[] | undefined;
  /** The primary dispatch task body — scanned for referenced repo-relative paths. */
  taskText: string;
  /** Effective write mode of the primary task ('worktree' | 'sequential' | 'scoped' | undefined). */
  writeMode: string | undefined;
  /**
   * Non-primary tasks in a multi-task dispatch. The referenced-path check (Signal
   * 2b) runs per-task across the primary task + these, so a worktree implementer
   * at index ≥1 referencing a gitignored spec is still flagged. Stale-base and
   * mid-flight checks remain one-per-dispatch (repo-global) and ignore this.
   */
  additionalTasks?: ReadonlyArray<PreconditionGuardAdditionalTask>;
}

export interface PreconditionGuardResult {
  warnings: string[];
}

// ---------------------------------------------------------------------------
// captureHeadSha — best-effort HEAD capture for round registration
// ---------------------------------------------------------------------------

/**
 * Synchronously capture the current HEAD SHA for use as `roundStartSha`.
 * Returns undefined on any error (git unavailable, not a repo, etc.).
 * NEVER throws.
 *
 * @param projectRoot  - Directory to run `git rev-parse HEAD` in.
 *                       Falls back to process.cwd() when falsy.
 * @param execFile     - Injected git executor; defaults to execFileSync.
 */
export function captureHeadSha(
  projectRoot: string | undefined,
  execFile: (cmd: string, args: string[], opts: { cwd: string; encoding: 'utf8' }) => string = defaultExecFile,
): string | undefined {
  try {
    const cwd = projectRoot || process.cwd();
    const sha = execFile('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// getCommitsSince — commits between a base SHA and HEAD
// ---------------------------------------------------------------------------

/**
 * Return the list of commit SHAs that landed after `sinceSha` up to HEAD.
 * Uses `git log <sinceSha>..HEAD --format=%H`.
 * Returns [] on any error (never throws).
 *
 * @param sinceSha     - The base SHA (exclusive lower bound).
 * @param projectRoot  - Working directory for git.
 * @param execFile     - Injected git executor; defaults to execFileSync.
 */
export function getCommitsSince(
  sinceSha: string,
  projectRoot: string,
  execFile: (cmd: string, args: string[], opts: { cwd: string; encoding: 'utf8' }) => string = defaultExecFile,
): string[] {
  try {
    const output = execFile('git', ['log', `${sinceSha}..HEAD`, '--format=%H'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// runMidFlightCheck — UNIT 3 mid-flight fixup detector
// ---------------------------------------------------------------------------

/**
 * Detect commits that landed during Phase 2 cross-review (between round
 * registration and collect-end synthesis). When detected, appends a human-
 * readable warning and emits ONE `mid_flight_fixup` pipeline signal against
 * agentId:'orchestrator'.
 *
 * Design rules:
 *   - Falsy `roundStartSha` → immediate no-op {warnings:[]}.
 *   - Best-effort throughout; NEVER throws into the consensus collect path.
 *   - Injects all collaborators via `deps` for unit-testability.
 *
 * @param input  - Consensus round context (projectRoot, consensusId, roundStartSha).
 * @param deps   - Optional injected collaborators.
 */
export async function runMidFlightCheck(
  input: MidFlightCheckInput,
  deps: Partial<MidFlightCheckDeps> = {},
): Promise<MidFlightCheckResult> {
  const warnings: string[] = [];

  if (!input.roundStartSha) {
    return { warnings };
  }

  const execFile = deps.execFile ?? defaultExecFile;
  const emitSignals = deps.emitSignals ?? defaultEmitSignals;

  try {
    const { projectRoot, consensusId, roundStartSha } = input;

    const commits = getCommitsSince(roundStartSha, projectRoot, execFile);
    const { detected, count } = detectMidFlightCommits(commits);

    if (!detected) {
      return { warnings };
    }

    warnings.push(
      `[mid-flight-fixup] ${count} commit(s) landed during Phase 2 cross-review ` +
      `(since ${roundStartSha.slice(0, 8)}). Reviewers may have seen post-fix code ` +
      `and marked legitimate Phase 1 findings DISAGREE. Consensus round: ${consensusId}.`,
    );

    try {
      emitSignals(projectRoot, [{
        type: 'pipeline' as const,
        signal: 'mid_flight_fixup',
        agentId: 'orchestrator',
        taskId: consensusId,
        consensusId,
        metadata: {
          count,
          roundStartSha,
          commits,
        },
        timestamp: new Date().toISOString(),
      }]);
    } catch { /* best-effort */ }
  } catch { /* outer best-effort guard — must never propagate */ }

  return { warnings };
}

// ---------------------------------------------------------------------------
// Default collaborator factories (real I/O)
// ---------------------------------------------------------------------------

function defaultExecFile(
  cmd: string,
  args: string[],
  opts: { cwd: string; encoding: 'utf8' },
): string {
  return execFileSync(cmd, args, opts) as string;
}

function defaultCanRead(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Production predicate: does the repo-relative path exist + read at projectRoot?
 * Best-effort — any error (including a path that escapes the root) → false.
 */
function defaultPathExists(projectRoot: string, p: string): boolean {
  try {
    const resolved = path.resolve(projectRoot, p);
    fs.accessSync(resolved, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Production predicate: is the repo-relative path gitignored OR untracked (so it
 * is absent from a fresh worktree checkout)?
 *
 * `git check-ignore <p>` exits 0 when the path IS ignored. `git ls-files
 * --error-unmatch <p>` exits 0 when the path IS tracked; non-zero (throw) means
 * untracked. A path is absent from a fresh checkout iff it is ignored OR
 * untracked. Best-effort: on any git failure we return false (safe default —
 * assume present rather than emit a spurious signal).
 */
function defaultIsGitignoredOrUntracked(
  projectRoot: string,
  p: string,
  execFile: PreconditionRunnerDeps['execFile'],
): boolean {
  // Is it gitignored?
  try {
    execFile('git', ['check-ignore', '-q', p], { cwd: projectRoot, encoding: 'utf8' });
    return true; // exit 0 → ignored
  } catch {
    // non-zero exit → not ignored (fall through to tracked check)
  }
  // Not ignored — is it tracked? Untracked ⇒ absent from a fresh checkout.
  try {
    execFile('git', ['ls-files', '--error-unmatch', p], { cwd: projectRoot, encoding: 'utf8' });
    return false; // exit 0 → tracked → present in checkout
  } catch {
    return true; // non-zero → untracked → absent from checkout
  }
}

function defaultEmitSignals(projectRoot: string, signals: PerformanceSignal[]): void {
  // FIX 6: use static import (bundled by esbuild). Dynamic import() is NOT
  // bundled in esbuild single-file builds — it silently no-ops at runtime.
  try {
    staticEmitPipelineSignals(projectRoot, signals);
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// gatherStaleBaseInputs
// ---------------------------------------------------------------------------

/**
 * Run the three git commands needed by detectStaleBase.
 * Returns null if git is unavailable, not in a repo, or origin/master is
 * unreachable. NEVER throws.
 */
export async function gatherStaleBaseInputs(
  projectRoot: string,
  execFile: PreconditionRunnerDeps['execFile'] = defaultExecFile,
): Promise<StaleBaseInputs | null> {
  try {
    const dispatchSha = execFile('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();

    const originMasterSha = execFile('git', ['rev-parse', 'origin/master'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();

    const mergeBaseSha = execFile('git', ['merge-base', 'HEAD', 'origin/master'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();

    return { dispatchSha, originMasterSha, mergeBaseSha };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// runDispatchPreconditionGuard
// ---------------------------------------------------------------------------

/**
 * Run the UNIT 2 pre-dispatch guard for signals 1 (dispatched_stale_base) and
 * 2 (referenced_unreadable_path). For each triggered precondition:
 *   (a) Appends a human-readable warning to the returned array.
 *   (b) Emits a pipeline signal against agentId:'orchestrator'.
 *
 * Is additive and best-effort: a failure inside the guard NEVER propagates to
 * the caller.
 */
export async function runDispatchPreconditionGuard(
  input: PreconditionGuardInput,
  deps: Partial<PreconditionRunnerDeps> = {},
): Promise<PreconditionGuardResult> {
  const warnings: string[] = [];

  const execFile = deps.execFile ?? defaultExecFile;
  const canRead = deps.canRead ?? defaultCanRead;
  const pathExists = deps.pathExists ?? defaultPathExists;
  const isGitignoredOrUntracked = deps.isGitignoredOrUntracked ?? defaultIsGitignoredOrUntracked;
  const emitSignals = deps.emitSignals ?? defaultEmitSignals;

  const { projectRoot, taskId, resolutionRoots, taskText, writeMode, additionalTasks } = input;

  try {
    // -----------------------------------------------------------------------
    // Signal 1: dispatched_stale_base
    // -----------------------------------------------------------------------
    const gitInputs = await gatherStaleBaseInputs(projectRoot, execFile);
    if (gitInputs !== null) {
      const staleResult = detectStaleBase(
        gitInputs.dispatchSha,
        gitInputs.originMasterSha,
        gitInputs.mergeBaseSha,
      );
      if (staleResult.stale && staleResult.reason !== null) {
        const reason = staleResult.reason;
        warnings.push(
          `[dispatch-hygiene] stale base detected (${reason}): ` +
          `dispatch SHA ${gitInputs.dispatchSha} is behind origin/master ` +
          `${gitInputs.originMasterSha}. Pull and rebase before dispatching.`,
        );
        try {
          emitSignals(projectRoot, [{
            type: 'pipeline' as const,
            signal: 'dispatched_stale_base',
            agentId: 'orchestrator',
            taskId,
            metadata: {
              reason,
              dispatchSha: gitInputs.dispatchSha,
            },
            timestamp: new Date().toISOString(),
          }]);
        } catch { /* best-effort */ }
      }
    }

    // -----------------------------------------------------------------------
    // Signal 2: referenced_unreadable_path
    // -----------------------------------------------------------------------
    const roots = resolutionRoots ?? [];
    if (roots.length > 0) {
      let unreadable: string[];
      try {
        unreadable = findUnreadablePaths(roots, canRead);
      } catch {
        // canRead itself threw — treat as empty (safe degradation)
        unreadable = [];
      }
      if (unreadable.length > 0) {
        warnings.push(
          `[dispatch-hygiene] ${unreadable.length} resolutionRoot(s) are unreadable: ` +
          `${unreadable.join(', ')}. Cross-reviewers will fall back to project root.`,
        );
        try {
          emitSignals(projectRoot, [{
            type: 'pipeline' as const,
            signal: 'referenced_unreadable_path',
            agentId: 'orchestrator',
            taskId,
            metadata: {
              unreadable,
            },
            timestamp: new Date().toISOString(),
          }]);
        } catch { /* best-effort */ }
      }
    }

    // -----------------------------------------------------------------------
    // Signal 2b: referenced_unreadable_path — task-text path check (Bug A fix).
    //
    // Scans the TASK TEXT for referenced repo-relative paths the executing
    // agent won't be able to read. This is the signal's DOCUMENTED purpose:
    // the recurring "worktree agent can't read a gitignored docs/specs/*.md"
    // failure. The resolutionRoots check above is a distinct, near-dead path
    // (kept as-is for safety). All fs/git access is wrapped — never throws.
    //
    // PER-TASK: scans the primary task PLUS every additionalTask, each under
    // THAT task's own writeMode (a path is only gitignored_in_worktree for a
    // worktree task). Unreadable paths are deduped by `path` across all tasks
    // (gitignored_in_worktree preferred over missing when both occur), so an
    // index-≥1 worktree implementer referencing a gitignored spec is flagged.
    // -----------------------------------------------------------------------
    const scanTasks: PreconditionGuardAdditionalTask[] = [];
    if (taskText) {
      scanTasks.push({ taskText, writeMode });
    }
    if (additionalTasks) {
      for (const t of additionalTasks) {
        if (t && t.taskText) {
          scanTasks.push({ taskText: t.taskText, writeMode: t.writeMode });
        }
      }
    }

    if (scanTasks.length > 0) {
      // Dedupe by path; prefer gitignored_in_worktree over missing.
      const byPath = new Map<string, UnreadableReferencedPath>();
      let droppedOverCap = 0;

      for (const t of scanTasks) {
        let result: { unreadable: UnreadableReferencedPath[]; droppedOverCap: number } = {
          unreadable: [],
          droppedOverCap: 0,
        };
        try {
          result = findUnreadableReferencedPathsWithMeta(t.taskText, {
            writeMode: t.writeMode,
            pathExists: (p: string) => {
              try {
                return pathExists(projectRoot, p);
              } catch {
                return true; // safe default: assume present → no spurious signal
              }
            },
            isGitignoredOrUntracked: (p: string) => {
              try {
                return isGitignoredOrUntracked(projectRoot, p, execFile);
              } catch {
                return false; // safe default: assume present in checkout
              }
            },
          });
        } catch {
          result = { unreadable: [], droppedOverCap: 0 }; // safe degradation
        }

        droppedOverCap += result.droppedOverCap;

        for (const entry of result.unreadable) {
          const existing = byPath.get(entry.path);
          if (!existing) {
            byPath.set(entry.path, entry);
          } else if (
            existing.reason !== 'gitignored_in_worktree' &&
            entry.reason === 'gitignored_in_worktree'
          ) {
            byPath.set(entry.path, entry); // upgrade missing → gitignored_in_worktree
          }
        }
      }

      const referenced = [...byPath.values()];

      if (referenced.length > 0) {
        const detail = referenced.map(r => `${r.path} (${r.reason})`).join(', ');
        warnings.push(
          `[dispatch-hygiene] ${referenced.length} referenced path(s) the dispatched ` +
          `agent cannot read: ${detail}. The agent may fail mid-task — inline the ` +
          `file contents or copy it into the worktree.`,
        );
        try {
          emitSignals(projectRoot, [{
            type: 'pipeline' as const,
            signal: 'referenced_unreadable_path',
            agentId: 'orchestrator',
            taskId,
            metadata: {
              referenced,
            },
            timestamp: new Date().toISOString(),
          }]);
        } catch { /* best-effort */ }
      }

      // Fix 3: surface tokens dropped over the 20-path cap (best-effort, never
      // throws). The existence check never ran for these, so just warn.
      if (droppedOverCap > 0) {
        warnings.push(
          `[dispatch-hygiene] ${droppedOverCap} referenced path(s) beyond the 20-path ` +
          `cap were not checked.`,
        );
      }
    }
  } catch { /* outer best-effort guard — must never propagate */ }

  return { warnings };
}
