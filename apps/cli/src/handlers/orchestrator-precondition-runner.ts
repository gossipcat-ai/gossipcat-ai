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
import { execFileSync } from 'child_process';
import {
  detectStaleBase,
  findUnreadablePaths,
} from '@gossip/orchestrator/orchestrator-preconditions';
import type { PerformanceSignal } from '@gossip/orchestrator';

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
   * Best-effort pipeline signal emitter.
   * Signature mirrors emitPipelineSignals(projectRoot, signals).
   */
  emitSignals: (projectRoot: string, signals: PerformanceSignal[]) => void;
}

export interface StaleBaseInputs {
  dispatchSha: string;
  originMasterSha: string;
  mergeBaseSha: string | null;
}

export interface PreconditionGuardInput {
  projectRoot: string;
  taskId: string;
  resolutionRoots: readonly string[] | undefined;
}

export interface PreconditionGuardResult {
  warnings: string[];
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

function defaultEmitSignals(projectRoot: string, signals: PerformanceSignal[]): void {
  // Dynamic import keeps the orchestrator coupling lazy and mirrors the
  // pattern from dispatch-prompt-cache.ts:emitCacheEvictedSignal.
  import('@gossip/orchestrator').then(({ emitPipelineSignals }) => {
    try {
      emitPipelineSignals(projectRoot, signals);
    } catch { /* best-effort */ }
  }).catch(() => { /* best-effort */ });
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
  const emitSignals = deps.emitSignals ?? defaultEmitSignals;

  const { projectRoot, taskId, resolutionRoots } = input;

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
  } catch { /* outer best-effort guard — must never propagate */ }

  return { warnings };
}
