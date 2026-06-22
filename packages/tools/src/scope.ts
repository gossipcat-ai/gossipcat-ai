import { dirname, basename, join } from 'path';
import { realpathSync, existsSync } from 'fs';

/**
 * Case-insensitive filesystems (darwin/win32) require case-folded path
 * compares — otherwise a scope of `packages/relay/` can be bypassed by a path
 * like `packages/RELAY/evil.ts` since the OS treats them as the same directory
 * but `startsWith` is case-sensitive.
 */
export const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32';

/**
 * Resolve a path to its canonical form for boundary comparison:
 *   1. Follow symlinks via realpathSync so a planted symlink in-scope cannot
 *      escape to an out-of-scope target. If the target does not exist yet
 *      (common for file_write), resolve the parent and re-attach the basename.
 *   2. Case-fold on case-insensitive filesystems.
 *   3. Append a trailing slash so sibling-prefix bypass (e.g. `packages/relay2/`
 *      matching scope `packages/relay/`) is impossible.
 *
 * The non-existent-path branch is SECURITY-CRITICAL for `/file-write` on new
 * paths: without it, planted symlinks in ancestor directories could hide an
 * escape during the write. Both branches must be preserved verbatim.
 *
 * @param p Absolute path to canonicalize. Caller is expected to have already
 *   joined the path against its scope root (e.g. via `resolve(root, rel)`).
 */
export function canonicalizeForBoundary(p: string): string {
  let out = p;
  if (existsSync(out)) {
    try { out = realpathSync(out); } catch { /* best-effort */ }
  } else {
    // Path does not exist — resolve symlinks in the parent directory instead,
    // then reattach the basename. This prevents symlinks in ancestor dirs from
    // hiding an escape during file_write.
    const parent = dirname(out);
    if (parent !== out && existsSync(parent)) {
      try { out = join(realpathSync(parent), basename(out)); } catch { /* best-effort */ }
    }
  }
  if (CASE_INSENSITIVE_FS) out = out.toLowerCase();
  return out.endsWith('/') ? out : out + '/';
}

/**
 * Membership check — does a canonicalized path fall inside a canonicalized
 * scope? Both arguments MUST already have been passed through
 * `canonicalizeForBoundary` (or be a stored canonical scope from
 * `assignScope`/`assignRoot`). This helper exists so the five inline
 * `startsWith(scope)` checks in `tool-server.ts` and any future bridge
 * endpoints share a single primitive.
 */
export function validatePathInScope(scope: string, canonicalPath: string): boolean {
  return canonicalPath.startsWith(scope);
}
