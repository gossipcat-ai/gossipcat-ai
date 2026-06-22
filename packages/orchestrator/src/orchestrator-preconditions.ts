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
  reason: 'behind_origin' | 'branched_pre_merge' | 'ahead_of_origin' | null;
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
 *   - Fresh:              dispatchSha === originMasterSha
 *                         Branch is exactly at origin/master — nothing to flag.
 *   - behind_origin:      dispatchSha !== originMasterSha AND
 *                         mergeBaseSha === dispatchSha
 *                         (dispatch SHA is an ancestor of origin/master — HEAD ⊂ origin;
 *                         the local branch just hasn't been pulled up yet)
 *   - ahead_of_origin:    dispatchSha !== originMasterSha AND
 *                         mergeBaseSha === originMasterSha
 *                         (origin/master is an ancestor of HEAD — origin ⊂ HEAD;
 *                         branch is strictly ahead with no divergence; the normal
 *                         review-on-branch workflow — NOT stale, informational only)
 *   - branched_pre_merge: dispatchSha !== originMasterSha AND
 *                         mergeBaseSha !== dispatchSha AND mergeBaseSha !== originMasterSha
 *                         (or mergeBaseSha is null — true divergence; origin has commits
 *                         that branched from a common ancestor this branch has never seen;
 *                         merge-base equals neither SHA)
 */
export function detectStaleBase(
  dispatchSha: string,
  originMasterSha: string,
  mergeBaseSha: string | null,
): StaleBaseResult {
  // Case 1: exactly on origin/master — fresh, nothing to flag.
  if (dispatchSha === originMasterSha) {
    return { stale: false, reason: null };
  }

  // Case 2: HEAD is an ancestor of origin/master (behind_origin).
  if (mergeBaseSha === dispatchSha) {
    return { stale: true, reason: 'behind_origin' };
  }

  // Case 3: origin/master is an ancestor of HEAD (strictly ahead — NOT stale).
  if (mergeBaseSha === originMasterSha) {
    return { stale: false, reason: 'ahead_of_origin' };
  }

  // Case 4: true divergence — merge-base is neither dispatch nor origin SHA
  // (includes mergeBaseSha === null).
  return { stale: true, reason: 'branched_pre_merge' };
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
// extractReferencedPaths
// ---------------------------------------------------------------------------

/**
 * Conservative repo-path shape: an optional `./` prefix followed by
 * word/dot/slash/dash chars, ending in a known source/doc extension. The
 * extension allowlist keeps the extractor narrow so arbitrary prose tokens
 * (e.g. "e.g." or version strings) don't get treated as referenced files.
 */
const REPO_PATH_SHAPE = /^(?:\.\/)?[\w./-]+\.(?:md|ts|tsx|js|json|txt|ya?ml)$/;

/** Max number of distinct referenced paths checked per dispatch. */
const MAX_REFERENCED_PATHS = 20;

/**
 * Result of {@link extractReferencedPathsWithMeta}: the extracted paths plus a
 * count of how many additional distinct path tokens were dropped because the
 * {@link MAX_REFERENCED_PATHS} cap was reached.
 */
export interface ExtractReferencedPathsResult {
  /** Up to {@link MAX_REFERENCED_PATHS} distinct paths, first-seen order. */
  paths: string[];
  /**
   * Number of further DISTINCT, shape-valid path tokens that were not included
   * because the cap was already full. 0 when nothing was dropped over the cap.
   */
  droppedOverCap: number;
}

/**
 * Extract repo-relative, path-shaped tokens from free-form task text, returning
 * both the (capped) path list and a count of distinct tokens dropped over the
 * cap. See {@link extractReferencedPaths} for the matching rules.
 *
 * @param taskText - The dispatch task body to scan.
 * @returns The capped path list plus `droppedOverCap`.
 */
export function extractReferencedPathsWithMeta(
  taskText: string,
): ExtractReferencedPathsResult {
  if (!taskText) {
    return { paths: [], droppedOverCap: 0 };
  }

  // Split on whitespace AND backticks so `path` and bare path both yield the
  // raw token. Backticks are treated purely as delimiters here.
  const rawTokens = taskText.split(/[\s`]+/);

  const seen = new Set<string>();
  const out: string[] = [];
  let droppedOverCap = 0;

  for (const raw of rawTokens) {
    // Trim leading/trailing punctuation that commonly abuts a path in prose
    // (e.g. "see foo.ts," or "(bar.md)") without altering the path itself.
    const trimmed = raw.replace(/^[([{<"']+/, '').replace(/[)\]}>"',.;:]+$/, '');
    // Strip a trailing line/col citation suffix (`path:line` or `path:line:col`)
    // BEFORE the shape test — this codebase cites `path:line` pervasively, and
    // the digits would otherwise fail REPO_PATH_SHAPE and drop the reference.
    // Conservative: only a trailing :<digits>[:<digits>], never mid-path.
    const token = trimmed.replace(/:\d+(?::\d+)?$/, '');
    if (token.length === 0) {
      continue;
    }
    // Reject absolute paths and traversal outright.
    if (token.startsWith('/') || token.includes('..')) {
      continue;
    }
    if (!REPO_PATH_SHAPE.test(token)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    if (out.length >= MAX_REFERENCED_PATHS) {
      // Cap full: count this distinct, shape-valid token as dropped but keep
      // scanning so the dropped count reflects the true overflow.
      droppedOverCap += 1;
      continue;
    }
    out.push(token);
  }

  return { paths: out, droppedOverCap };
}

/**
 * Extract repo-relative, path-shaped tokens from free-form task text.
 *
 * Accepts tokens that are EITHER backtick-quoted OR bare whitespace-delimited,
 * provided they match {@link REPO_PATH_SHAPE}. Rejects:
 *   - absolute paths (leading `/`),
 *   - any token containing `..` (path traversal),
 * so only conservative repo-relative references survive. A trailing `path:line`
 * (or `path:line:col`) citation suffix is stripped before the shape test.
 *
 * Results are de-duplicated (first-seen order preserved) and CAPPED at
 * {@link MAX_REFERENCED_PATHS}; tokens beyond the cap are dropped. The function
 * is pure — it performs no filesystem access. Use
 * {@link extractReferencedPathsWithMeta} when you also need the over-cap count.
 *
 * @param taskText - The dispatch task body to scan.
 * @returns Up to 20 distinct repo-relative path tokens, in first-seen order.
 */
export function extractReferencedPaths(taskText: string): string[] {
  return extractReferencedPathsWithMeta(taskText).paths;
}

// ---------------------------------------------------------------------------
// findUnreadableReferencedPaths
// ---------------------------------------------------------------------------

export type UnreadableReason = 'missing' | 'gitignored_in_worktree';

export interface UnreadableReferencedPath {
  path: string;
  reason: UnreadableReason;
}

export interface FindUnreadableReferencedPathsResult {
  /** One entry per unreadable referenced path (readable paths omitted). */
  unreadable: UnreadableReferencedPath[];
  /**
   * Count of distinct, shape-valid path tokens dropped because the 20-path cap
   * was reached BEFORE any existence check ran. 0 when nothing was dropped.
   */
  droppedOverCap: number;
}

export interface FindUnreadableReferencedPathsOpts {
  /**
   * Effective write mode of the dispatch. `'worktree'` means the agent runs in
   * a fresh checkout (so gitignored/untracked files are absent); any other
   * value (or undefined) means the agent runs from the repo root.
   */
  writeMode?: string;
  /** True iff the path exists / is readable at the project root. */
  pathExists(p: string): boolean;
  /** True iff the path is gitignored OR untracked (absent from a fresh checkout). */
  isGitignoredOrUntracked(p: string): boolean;
}

/**
 * Given task text, determine which referenced repo-relative paths the executing
 * agent will be UNABLE to read, and why.
 *
 * Reasoning (all I/O is injected, so this stays pure + unit-testable):
 *   - `writeMode === 'worktree'`: the agent runs in a fresh checkout. A path is
 *     unreadable iff it is absent from that checkout — i.e. gitignored OR
 *     untracked → reason `'gitignored_in_worktree'`. If the path does not exist
 *     at the repo root at all → reason `'missing'` (a typo / nonexistent ref).
 *   - any other writeMode: the agent runs from the repo root. A path is
 *     unreadable iff it does not exist / is not readable there → `'missing'`.
 *
 * @param taskText - The dispatch task body.
 * @param opts     - Injected write-mode + predicates.
 * @returns One entry per unreadable referenced path (readable paths omitted).
 */
export function findUnreadableReferencedPaths(
  taskText: string,
  opts: FindUnreadableReferencedPathsOpts,
): UnreadableReferencedPath[] {
  return findUnreadableReferencedPathsWithMeta(taskText, opts).unreadable;
}

/**
 * Variant of {@link findUnreadableReferencedPaths} that also reports how many
 * distinct referenced-path tokens were dropped because the 20-path cap was hit
 * before any existence check ran. Callers that surface an over-cap warning use
 * this; everything else can use {@link findUnreadableReferencedPaths}.
 */
export function findUnreadableReferencedPathsWithMeta(
  taskText: string,
  opts: FindUnreadableReferencedPathsOpts,
): FindUnreadableReferencedPathsResult {
  const { paths, droppedOverCap } = extractReferencedPathsWithMeta(taskText);
  const out: UnreadableReferencedPath[] = [];

  const isWorktree = opts.writeMode === 'worktree';

  for (const path of paths) {
    const exists = opts.pathExists(path);
    if (!exists) {
      out.push({ path, reason: 'missing' });
      continue;
    }
    if (isWorktree && opts.isGitignoredOrUntracked(path)) {
      out.push({ path, reason: 'gitignored_in_worktree' });
    }
  }

  return { unreadable: out, droppedOverCap };
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
