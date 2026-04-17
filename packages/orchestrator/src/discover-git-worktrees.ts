/**
 * discover-git-worktrees — opt-in auto-discovery of git worktrees for
 * consensus citation resolution (issue #126 / PR-B).
 *
 * Reads `git worktree list -z --porcelain`, parses, validates each entry
 * through the SAME `validateResolutionRoot` pipeline as explicit
 * resolutionRoots. Default OFF (config flag
 * `consensus.autoDiscoverWorktrees`).
 *
 * Parser lives in validate-resolution-root.ts (parseWorktreePorcelain);
 * this module runs the discover+validate cycle.
 */
import { listWorktreePaths, validateResolutionRoot, hashPath } from './validate-resolution-root';
import { log as _log } from './log';

export interface DiscoverResult {
  discovered: string[];
  rejected: Array<{ hashedInput: string; reason: string }>;
}

/**
 * Discover git worktrees under projectRoot and return canonical (realpath'd)
 * paths that pass `validateResolutionRoot`. Paths already present in
 * `exclude` (typically explicit resolutionRoots + projectRoot) are filtered
 * out to avoid double-counting.
 */
export async function discoverGitWorktrees(
  projectRoot: string,
  exclude: readonly string[] = [],
): Promise<DiscoverResult> {
  const discovered: string[] = [];
  const rejected: Array<{ hashedInput: string; reason: string }> = [];

  let paths: string[];
  try {
    paths = await listWorktreePaths(projectRoot);
  } catch (err) {
    return { discovered: [], rejected: [{ hashedInput: hashPath(projectRoot), reason: `git worktree list failed: ${(err as Error).message}`.slice(0, 200) }] };
  }

  const excludeSet = new Set(exclude);
  for (const p of paths) {
    if (excludeSet.has(p)) continue;
    const result = await validateResolutionRoot(p, projectRoot);
    if (result.valid) {
      if (!excludeSet.has(result.canonical)) {
        discovered.push(result.canonical);
        excludeSet.add(result.canonical);
      }
    } else {
      rejected.push({ hashedInput: result.hashedInput, reason: result.reason });
    }
  }

  return { discovered, rejected };
}
