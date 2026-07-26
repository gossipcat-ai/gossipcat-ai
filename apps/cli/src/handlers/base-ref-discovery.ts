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

let cachedResult: BaseRefResult | null = null;

/** Test-only: clear the per-process cache between test cases. */
export function resetBaseRefDiscoveryCache(): void {
  cachedResult = null;
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
 * Discover the base ref to use in place of a hardcoded 'origin/master'.
 * Cached per-process after the first successful (or exhausted) call —
 * pass `forceRefresh: true` to bypass the cache (tests only).
 */
export function discoverBaseRef(
  cwd: string = process.cwd(),
  execFile: ExecFileLike = defaultExecFile,
  forceRefresh = false,
): BaseRefResult {
  if (cachedResult && !forceRefresh) return cachedResult;

  // 1. Explicit override — always wins, no git calls needed.
  const override = process.env.GOSSIP_BASE_REF?.trim();
  if (override) {
    cachedResult = { ref: override };
    return cachedResult;
  }

  // 2. origin/HEAD symbolic-ref — the ref git itself points at.
  const symbolicRef = tryExec(execFile, cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolicRef) {
    const match = symbolicRef.match(/^refs\/remotes\/(.+)$/);
    const candidate = match?.[1];
    if (candidate && refResolves(execFile, cwd, candidate)) {
      cachedResult = { ref: candidate };
      return cachedResult;
    }
    // symbolic-ref pointed somewhere that doesn't resolve (stale ref) — fall
    // through to the fixed-candidate fallback below.
  }

  // 3. Fixed fallback candidates, in order.
  for (const candidate of ['origin/master', 'origin/main']) {
    if (refResolves(execFile, cwd, candidate)) {
      cachedResult = { ref: candidate };
      return cachedResult;
    }
  }

  // 4. Nothing resolved — distinguish "offline / no origin remote" from
  // "origin is reachable, it just doesn't have a ref we recognize".
  const remoteList = tryExec(execFile, cwd, ['remote']);
  const hasOriginRemote = remoteList !== null
    && remoteList.split('\n').map(line => line.trim()).includes('origin');

  cachedResult = {
    ref: null,
    diagnostic: hasOriginRemote
      ? 'no such base ref (checked origin/master, origin/main; origin/HEAD unset or unresolvable)'
      : 'offline or no remote named "origin"',
  };
  return cachedResult;
}
