import { resolve, dirname } from 'path';
import { existsSync, realpathSync } from 'fs';

/**
 * Case-insensitive filesystems (darwin/win32) require case-folded path
 * compares — otherwise a worktree root of `/tmp/gossip-wt-AB/` could be
 * matched by `/TMP/gossip-wt-AB/…` on the same disk. Mirrors the behavior
 * of scope.ts so Sandbox and scope enforcement agree.
 */
const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32';

function fold(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/**
 * Canonical trailing-slash form for the root side of a prefix comparison.
 * Blocks sibling-prefix bypass: e.g. a root of `/tmp/gossip-wt-AB` must not
 * accept `/tmp/gossip-wt-ABXYZ/file.txt`. A filesystem root (`/`) is left
 * as-is since it already ends in `/`.
 */
function rootWithSlash(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

export class Sandbox {
  private root: string;

  constructor(projectRoot: string) {
    this.root = realpathSync(resolve(projectRoot));
  }

  get projectRoot(): string { return this.root; }

  /**
   * Validate that a path resolves within the project root OR inside any
   * entry in `allowedRoots` (union-of-roots). Handles non-existent files
   * (for file_write) by walking up to the deepest existing ancestor and
   * resolving from there. Resolves symlinks BEFORE the membership check
   * to prevent symlink escape attacks.
   *
   * Preserves these security properties:
   *   - path.resolve() on candidate AND every allowed root before compare
   *   - realpathSync on deepest existing ancestor of candidate
   *   - trailing-slash canonical form on root side (blocks sibling-prefix
   *     bypass like `/tmp/gossip-wt-AB` vs `/tmp/gossip-wt-ABXYZ`)
   *   - case-fold on darwin/win32
   *
   * @param filePath  Path to validate. May be relative (resolved against
   *                  projectRoot) or absolute.
   * @param allowedRoots Optional absolute paths that should also be
   *                  accepted as roots. Defaults to `[]` so existing
   *                  callers are unchanged.
   */
  validatePath(filePath: string, allowedRoots: string[] = []): string {
    // Resolve relative paths against the agent's root when provided (worktree
    // mode), otherwise the project root. Absolute paths are handled by
    // path.resolve ignoring the base, so union-of-roots semantics are preserved
    // by the downstream containment check against candidateRoots.
    const resolutionBase = allowedRoots[0] || this.root;
    const resolved = resolve(resolutionBase, filePath);

    // Walk up to deepest existing ancestor (handles file_write to new paths)
    let checkPath = resolved;
    while (!existsSync(checkPath)) {
      const parent = dirname(checkPath);
      if (parent === checkPath) break; // filesystem root
      checkPath = parent;
    }

    const real = existsSync(checkPath) ? realpathSync(checkPath) : checkPath;
    const remainder = resolved.slice(checkPath.length);
    const fullReal = real + remainder;

    // Build the set of candidate roots. this.root already went through
    // realpathSync in the constructor. allowedRoots are caller-supplied
    // absolute paths (e.g. agent worktree root); run realpathSync on each
    // when the path exists so a worktree under /var/folders (darwin) is
    // compared in its /private/var form.
    const candidateRoots: string[] = [this.root];
    for (const r of allowedRoots) {
      if (!r) continue;
      const absR = resolve(r);
      const realR = existsSync(absR) ? (() => {
        try { return realpathSync(absR); } catch { return absR; }
      })() : absR;
      candidateRoots.push(realR);
    }

    const foldedFull = fold(fullReal);
    for (const r of candidateRoots) {
      const foldedRoot = fold(r);
      if (foldedFull === foldedRoot) return fullReal;
      if (foldedFull.startsWith(rootWithSlash(foldedRoot))) return fullReal;
    }

    const msg = allowedRoots.length > 0
      ? `Path "${filePath}" resolves outside project root or agent root`
      : `Path "${filePath}" resolves outside project root`;
    throw new Error(msg);
  }
}
