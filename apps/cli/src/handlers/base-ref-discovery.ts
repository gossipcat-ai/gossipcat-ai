/**
 * base-ref-discovery.ts
 *
 * Resolves the git ref that stands in for "origin's default branch" for the
 * ref-allowlist pre-dispatch snapshot (ref-allowlist-detection.ts) and the
 * dispatched_stale_base precondition (orchestrator-precondition-runner.ts).
 *
 * Both call sites used to hardcode `origin/master`. On a repo whose default
 * branch is `main` (or anything else), `git rev-parse origin/master` fails
 * with `fatal: ambiguous argument 'origin/master'` on every single dispatch,
 * printing noise and silently disabling both features. Issue #658.
 *
 * Precedence:
 *   1. `GOSSIP_BASE_REF` env var — explicit operator override, always wins.
 *   2. `git symbolic-ref refs/remotes/origin/HEAD` — the ref git itself
 *      considers to be origin's default branch (e.g. `refs/remotes/origin/main`
 *      → `origin/main`). May be unset on some clones (shallow clones, some CI
 *      checkouts) — handled quietly, falls through to (3).
 *   3. First of `origin/master`, `origin/main` that resolves via
 *      `git rev-parse --verify --quiet <ref>` (`--quiet` suppresses the
 *      `fatal:` line so a missing candidate produces no log noise).
 *   4. Give up — `ref: null` with a diagnostic that distinguishes "no remote
 *      reachable" (offline / no `origin` remote) from "remote is fine, we
 *      just couldn't find a base ref" (checked candidates, none resolved).
 *
 * Cached per-process (module-level) so discovery runs once per process, not
 * once per dispatch. `resetBaseRefDiscoveryCache()` is exported for tests.
 */
import { execFileSync } from 'child_process';

export type ExecFileLike = (
  cmd: string,
  args: string[],
  opts: { cwd: string; encoding: 'utf8' },
) => string;

export interface BaseRefResult {
  /** The resolved base ref (e.g. 'origin/main'), or null if none resolved. */
  ref: string | null;
  /** Human-readable reason discovery failed. Present only when ref is null. */
  diagnostic?: string;
}

/**
 * Positive results only, keyed by cwd. Two deliberate properties:
 *
 * - Keyed by cwd: a long-lived MCP server can dispatch against more than one
 *   root (worktrees), and an unkeyed cache serves the first repo's ref to every
 *   later one.
 * - Negatives are NEVER cached: a `null` result means "no base ref right now",
 *   which self-heals the moment the operator adds a remote or fetches. Caching
 *   it disabled both the ref-allowlist snapshot and `dispatched_stale_base` for
 *   the rest of the process, with no way to recover short of a restart.
 */
const cachedByCwd = new Map<string, BaseRefResult>();

/** Test-only: clear the per-process cache between test cases. */
export function resetBaseRefDiscoveryCache(): void {
  cachedByCwd.clear();
}

function defaultExecFile(cmd: string, args: string[], opts: { cwd: string; encoding: 'utf8' }): string {
  return execFileSync(cmd, args, opts) as string;
}

/** Run a git command, returning trimmed stdout or null on any failure. Never throws. */
function tryExec(execFile: ExecFileLike, cwd: string, args: string[]): string | null {
  try {
    const out = execFile('git', args, { cwd, encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** True when `git rev-parse --verify --quiet <ref>` succeeds (ref exists and resolves). */
function refResolves(execFile: ExecFileLike, cwd: string, ref: string): boolean {
  return tryExec(execFile, cwd, ['rev-parse', '--verify', '--quiet', ref]) !== null;
}

/**
 * Reject an override that is not shaped like a ref name before it reaches git.
 *
 * A leading `-` would be parsed by git as an OPTION rather than a ref, and
 * whitespace/newlines mean the operator pasted something that is not a single
 * ref. Neither is exploitable (execFileSync passes an argv array, no shell),
 * but both produce a non-SHA `preSha` that silently corrupts the ref-allowlist
 * verdict, so fail loud instead.
 */
function isRefShaped(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-') && !/[\s\x00]/.test(ref);
}

/**
 * True when `ref` names a remote-tracking ref. The base ref MUST be
 * remote-tracking: pointing it at a LOCAL branch makes the direct-push detector
 * compare against a branch the agent legitimately commits to, so any unrelated
 * local commit during a task is reported as a REF-ALLOWLIST VIOLATION and emits
 * a high-severity boundary_escape against an innocent agent. `GOSSIP_BASE_REF=master`
 * (a missing `origin/` prefix) is the realistic way to hit that.
 */
function isRemoteTrackingRef(execFile: ExecFileLike, cwd: string, ref: string): boolean {
  const full = tryExec(execFile, cwd, ['rev-parse', '--symbolic-full-name', ref]);
  return full !== null && full.startsWith('refs/remotes/');
}

/**
 * Discover the base ref to use in place of a hardcoded 'origin/master'.
 *
 * POSITIVE results are cached per cwd for the process lifetime; negative
 * results are NOT cached, so adding a remote or fetching mid-session recovers
 * without an MCP restart. `forceRefresh` bypasses the cache (tests only).
 */
export function discoverBaseRef(
  cwd: string = process.cwd(),
  execFile: ExecFileLike = defaultExecFile,
  forceRefresh = false,
): BaseRefResult {
  // 1. Explicit override — always wins. Read BEFORE the cache so an operator
  // who sets GOSSIP_BASE_REF to recover from a failed discovery is not served a
  // stale answer, and validated so a malformed value fails loud.
  const override = process.env.GOSSIP_BASE_REF?.trim();
  if (override) {
    if (!isRefShaped(override)) {
      return {
        ref: null,
        diagnostic: `GOSSIP_BASE_REF=${JSON.stringify(override)} is not a valid ref name (leading "-" or whitespace) — ignoring`,
      };
    }
    if (!refResolves(execFile, cwd, override)) {
      return { ref: null, diagnostic: `GOSSIP_BASE_REF=${override} does not resolve in this repository` };
    }
    if (!isRemoteTrackingRef(execFile, cwd, override)) {
      return {
        ref: null,
        diagnostic: `GOSSIP_BASE_REF=${override} is not a remote-tracking ref — use e.g. origin/${override}`,
      };
    }
    return { ref: override };
  }

  if (!forceRefresh) {
    const hit = cachedByCwd.get(cwd);
    if (hit) return hit;
  }

  // 2. origin/HEAD symbolic-ref — the ref git itself points at.
  const symbolicRef = tryExec(execFile, cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolicRef) {
    const match = symbolicRef.match(/^refs\/remotes\/(.+)$/);
    const candidate = match?.[1];
    if (candidate && refResolves(execFile, cwd, candidate)) {
      const result = { ref: candidate };
      cachedByCwd.set(cwd, result);
      return result;
    }
    // symbolic-ref pointed somewhere that doesn't resolve (stale ref) — fall
    // through to the fixed-candidate fallback below.
  }

  // 3. Fixed fallback candidates, in order.
  for (const candidate of ['origin/master', 'origin/main']) {
    if (refResolves(execFile, cwd, candidate)) {
      const result = { ref: candidate };
      cachedByCwd.set(cwd, result);
      return result;
    }
  }

  // 4. Nothing resolved. NOT cached — see cachedByCwd. Every git call above is a
  // local ref/config lookup, so "offline" is never the true cause; the honest
  // set is git-unavailable, not-a-repository, or no origin remote configured.
  const remoteList = tryExec(execFile, cwd, ['remote']);
  const hasOriginRemote = remoteList !== null
    && remoteList.split('\n').map(line => line.trim()).includes('origin');

  return {
    ref: null,
    diagnostic: hasOriginRemote
      ? 'no such base ref (checked origin/master, origin/main; origin/HEAD unset or unresolvable)'
      : 'no base ref: git unavailable, not a git repository, or no remote named "origin"',
  };
}
