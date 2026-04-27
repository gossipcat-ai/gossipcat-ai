/**
 * validate-resolution-root — pure validator for user-supplied citation
 * resolution roots (issue #126 / PR-B). Runs AT THE MCP BOUNDARY only.
 *
 * Pipeline (strict order, short-circuit on fail):
 *   1. NUL / control-char scan → REJECT ROUND (caller must abort)
 *   2. `..` component after path.normalize → drop + log
 *   3. resolves to existing directory (stat) → drop + log
 *   4. realpathSync succeeds → drop + log
 *   5. owner = current uid → drop + log
 *   6. `git -C <candidate> rev-parse --git-common-dir` matches projectRoot's
 *      git-common-dir → drop + log
 *   7. candidate appears in `git -C projectRoot worktree list -z --porcelain`
 *      → drop + log
 *
 * Success returns canonical form = realpath'd absolute path. Downstream code
 * MUST use this form (defeats TOCTOU).
 *
 * Git invocation is hardened with GIT_CONFIG_GLOBAL=/dev/null,
 * GIT_CONFIG_SYSTEM=/dev/null, GIT_CONFIG_NOSYSTEM=1 to neutralize outer
 * config that could influence candidate .git/config parsing.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { statSync, realpathSync } from 'fs';
import { normalize, resolve } from 'path';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const GIT_EXEC_OPTS = {
  env: { ...process.env, ...GIT_ENV },
  timeout: 30_000,
  maxBuffer: 1 << 20,
};

export type ValidationResult =
  | { valid: true; canonical: string }
  | { valid: false; reason: string; hashedInput: string; fatal?: boolean };

/** sha256:first-8-hex of the raw input — used for observability on rejected paths. */
export function hashPath(input: string): string {
  const h = createHash('sha256').update(input).digest('hex').slice(0, 8);
  return `sha256:${h}`;
}

/** Control-char / NUL scan. Returns true if the string contains any `\x00-\x1f`. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x00 && c <= 0x1f) return true;
  }
  return false;
}

/**
 * Look up the git-common-dir of a repo-ish path. Returns absolute path or null
 * on any git error (missing binary, non-zero exit, timeout, ENOENT). Never
 * throws.
 */
export async function gitCommonDir(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', path, 'rev-parse', '--git-common-dir'],
      GIT_EXEC_OPTS,
    );
    const out = stdout.trim();
    if (!out) return null;
    // Normalize to absolute and realpath'd
    try {
      return realpathSync(resolve(path, out));
    } catch {
      return resolve(path, out);
    }
  } catch {
    return null;
  }
}

/**
 * List worktree paths via `git -C projectRoot worktree list -z --porcelain`.
 * Skips bare / locked / prunable. Capped at 100 entries. Returns realpath'd
 * absolute paths. Never throws.
 *
 * Pass `includeLocked: true` to include locked worktrees (needed when
 * validating explicit user-supplied resolutionRoots — agent worktrees are
 * always locked and must not be silently rejected).
 */
export async function listWorktreePaths(
  projectRoot: string,
  { includeLocked = false }: { includeLocked?: boolean } = {},
): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['worktree', 'list', '-z', '--porcelain'],
      { ...GIT_EXEC_OPTS, cwd: projectRoot },
    );
    return parseWorktreePorcelain(stdout, { includeLocked });
  } catch {
    return [];
  }
}

/**
 * Pure parser for `git worktree list -z --porcelain` output.
 * Format: fields within a record terminated by `\0`; records separated by
 * `\0\0` (the empty-line separator from non-z porcelain).
 *
 * Skips bare / locked-* / prunable-* entries (they emit `locked <why>` —
 * prefix match, not equality).
 *
 * Pass `includeLocked: true` to include locked worktrees in the output
 * (bare and prunable are still excluded). Required when validating
 * explicit user-supplied resolutionRoots — active agent worktrees are
 * always locked and must not be silently dropped on the explicit path.
 *
 * Cap at 100 entries to bound fanout on pathological repos.
 */
export function parseWorktreePorcelain(
  stdout: string,
  { includeLocked = false }: { includeLocked?: boolean } = {},
): string[] {
  const out: string[] = [];
  const records = stdout.split('\0\0');
  for (const rec of records) {
    if (!rec) continue;
    const fields = rec.split('\0').filter(Boolean);
    const worktreeField = fields.find((f) => f.startsWith('worktree '));
    if (!worktreeField) continue;
    const path = worktreeField.slice('worktree '.length);
    if (
      fields.some(
        (f) =>
          f === 'bare' ||
          (!includeLocked && f.startsWith('locked')) ||
          f.startsWith('prunable'),
      )
    ) {
      continue;
    }
    // Realpath best-effort so comparisons are canonical.
    let canonical = path;
    try {
      canonical = realpathSync(resolve(path));
    } catch {
      canonical = resolve(path);
    }
    out.push(canonical);
    if (out.length >= 100) break;
  }
  return out;
}

/**
 * Validate a single user-supplied resolution root against projectRoot.
 * Returns canonical (realpath'd) form on success. Only fatal outcome:
 * NUL / control-char input — caller MUST abort the round.
 */
export async function validateResolutionRoot(
  rawPath: string,
  projectRoot: string,
): Promise<ValidationResult> {
  const hashed = hashPath(rawPath);

  // 1. NUL / control chars — round-level reject.
  if (hasControlChars(rawPath)) {
    return {
      valid: false,
      reason: 'contains NUL or control characters (adversarial input)',
      hashedInput: hashed,
      fatal: true,
    };
  }

  // 2. `..` component after normalize.
  const normalized = normalize(rawPath);
  const segs = normalized.split(/[\\/]/);
  if (segs.includes('..')) {
    return { valid: false, reason: 'contains `..` traversal', hashedInput: hashed };
  }

  const absolute = resolve(projectRoot, rawPath);

  // 3. Existing directory.
  let st;
  try {
    st = statSync(absolute);
  } catch (e) {
    return {
      valid: false,
      reason: `path does not resolve to directory: ${(e as Error).message}`.slice(0, 200),
      hashedInput: hashed,
    };
  }
  if (!st.isDirectory()) {
    return { valid: false, reason: 'path is not a directory', hashedInput: hashed };
  }

  // 4. realpath succeeds.
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch (e) {
    return {
      valid: false,
      reason: `realpath failed: ${(e as Error).message}`.slice(0, 200),
      hashedInput: hashed,
    };
  }

  // 5. Ownership check — must be current user.
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid != null && st.uid !== uid) {
      return {
        valid: false,
        reason: `owner uid mismatch (file=${st.uid}, current=${uid})`,
        hashedInput: hashed,
      };
    }
  } catch {
    // Non-POSIX host (Windows); skip ownership check gracefully.
  }

  // 6. git-common-dir must match projectRoot's.
  const [candGcd, rootGcd] = await Promise.all([
    gitCommonDir(canonical),
    gitCommonDir(projectRoot),
  ]);
  if (!rootGcd) {
    // Can't verify against an un-git'd projectRoot — drop to be safe.
    return {
      valid: false,
      reason: 'projectRoot git-common-dir lookup failed',
      hashedInput: hashed,
    };
  }
  if (!candGcd) {
    return {
      valid: false,
      reason: 'candidate git-common-dir lookup failed (not a git repo?)',
      hashedInput: hashed,
    };
  }
  if (candGcd !== rootGcd) {
    return {
      valid: false,
      reason: 'outside git-common-dir (cross-repo or non-worktree)',
      hashedInput: hashed,
    };
  }

  // 7. Must appear in `git worktree list`.
  // includeLocked: true — active agent worktrees are always locked by git;
  // rejecting them here would silently break all explicit resolutionRoots
  // that point at in-use worktrees (root cause of consensus 3aa4a6ef regression).
  const worktrees = await listWorktreePaths(projectRoot, { includeLocked: true });
  // Project root itself is always a valid worktree by convention — include it.
  let projectRootReal = projectRoot;
  try {
    projectRootReal = realpathSync(projectRoot);
  } catch {
    /* keep as-is */
  }
  if (
    canonical !== projectRootReal &&
    !worktrees.some((w) => w === canonical)
  ) {
    return {
      valid: false,
      reason: 'not found in `git worktree list`',
      hashedInput: hashed,
    };
  }

  return { valid: true, canonical };
}
