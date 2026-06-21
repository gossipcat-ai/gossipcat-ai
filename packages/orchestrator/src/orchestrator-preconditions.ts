/**
 * orchestrator-preconditions.ts
 *
 * Pure, side-effect-free functions for detecting orchestrator dispatch-hygiene
 * failures. All collaborators (git SHA values, path-readability predicates,
 * commit lists) are injected as arguments so every function is unit-testable
 * without touching the filesystem or spawning child processes.
 *
 * These are the foundations for UNIT 1 of the orchestrator signal pipeline.
 * No wiring into dispatch.ts / collect.ts / mcp-server-sdk is done here.
 */

// ---------------------------------------------------------------------------
// detectStaleBase
// ---------------------------------------------------------------------------

export interface StaleBaseResult {
  stale: boolean;
  reason: 'behind_origin' | 'branched_pre_merge' | null;
}

/**
 * Detect whether a dispatch was started from a stale branch base.
 *
 * @param dispatchSha    - The git SHA at the time of dispatch (HEAD of the
 *                         working branch when the task was dispatched).
 * @param originMasterSha - The current HEAD of origin/master (or main).
 * @param mergeBaseSha   - Output of `git merge-base dispatchSha originMasterSha`,
 *                         or null if it could not be determined.
 *
 * Classification:
 *   - Fresh:             dispatchSha === originMasterSha
 *   - behind_origin:     dispatchSha !== originMasterSha AND
 *                        mergeBaseSha === dispatchSha
 *                        (dispatch SHA is an ancestor of origin master — the
 *                        branch just hasn't been pulled up yet)
 *   - branched_pre_merge: dispatchSha !== originMasterSha AND
 *                         mergeBaseSha !== dispatchSha (or null)
 *                         (branch diverged from a common ancestor that is not
 *                         the dispatch SHA itself — PRs have landed on origin
 *                         that this branch has never seen)
 */
export function detectStaleBase(
  dispatchSha: string,
  originMasterSha: string,
  mergeBaseSha: string | null,
): StaleBaseResult {
  if (dispatchSha === originMasterSha) {
    return { stale: false, reason: null };
  }

  // SHAs differ → stale. Distinguish sub-reason via mergeBase.
  const reason: 'behind_origin' | 'branched_pre_merge' =
    mergeBaseSha === dispatchSha ? 'behind_origin' : 'branched_pre_merge';

  return { stale: true, reason };
}

// ---------------------------------------------------------------------------
// findUnreadablePaths
// ---------------------------------------------------------------------------

/**
 * Return the subset of `paths` for which `canRead(p)` is false.
 *
 * The `canRead` predicate is injected so tests can exercise the function
 * without touching the real filesystem. Production callers pass a wrapper
 * around `fs.accessSync` or a similar check.
 *
 * @param paths    - Ordered list of file paths to check.
 * @param canRead  - Injected predicate; returns true when the path is readable.
 * @returns        Paths (in original order) for which canRead returned false.
 */
export function findUnreadablePaths(
  paths: readonly string[],
  canRead: (p: string) => boolean,
): string[] {
  return paths.filter(p => !canRead(p));
}

// ---------------------------------------------------------------------------
// detectMidFlightCommits
// ---------------------------------------------------------------------------

export interface MidFlightResult {
  detected: boolean;
  count: number;
}

/**
 * Detect commits that landed on the target branch AFTER dispatch was started
 * (i.e. between the dispatch SHA and the current HEAD).
 *
 * The commit list is injected (e.g. from `git log --format=%H dispatch..HEAD`)
 * so this function remains pure and testable without spawning a subprocess.
 *
 * @param commitsBetween - Ordered list of commit SHAs that landed mid-flight.
 *                         An empty array means no intervening commits.
 * @returns `{ detected: true, count: N }` when N > 0 commits are present;
 *          `{ detected: false, count: 0 }` for an empty list.
 */
export function detectMidFlightCommits(
  commitsBetween: readonly string[],
): MidFlightResult {
  const count = commitsBetween.length;
  return { detected: count > 0, count };
}
