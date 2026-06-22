// packages/orchestrator/src/file-lock.ts
//
// Cross-process advisory lock for the open-findings auto-resolver, per
// docs/specs/2026-04-27-open-findings-auto-resolve.md (rev2,
// consensus b3f57cc6-22c24114).
//
// Contract (`withResolverLock`):
//   - acquire `.gossip/.resolver.lock` via `fs.openSync(path, 'wx')` (POSIX
//     O_CREAT|O_EXCL — atomic creation, fails if file exists)
//   - write `{ pid, started_at }` JSON into the lock file for stale detection
//   - on contention: wait up to LOCK_WAIT_MS retrying every LOCK_POLL_MS
//   - on stale lock (>STALE_LOCK_MS): break with a stderr warning
//   - run callback under lock; release in finally{} regardless of outcome
//   - return null when timeout exceeded — caller treats as "skipped, lock
//     contended"; this is intentionally an error-free path so concurrent
//     manual + auto invocations never crash a consensus write
//
// The lock file path is a sibling of `.gossip/`, NOT under `.git/` —
// resolver state is project-local but agent-orchestrated, mirroring
// finding-resolutions.jsonl, watermark, etc. The lock is advisory: any
// process that ignores it can still race; this matches round-counter.ts's
// "single-orchestrator-per-project assumption."

import * as fs from 'fs';
import * as path from 'path';

const LOCK_FILENAME = '.resolver.lock';
const LOCK_WAIT_MS = 5_000;       // total wait budget before giving up
const LOCK_POLL_MS = 100;         // retry cadence while waiting
const STALE_LOCK_MS = 10 * 60_000; // older than 10 minutes → assumed orphaned

interface LockMetadata {
  pid: number;
  started_at: string; // ISO-8601
}

function lockPath(projectRoot: string): string {
  return path.join(projectRoot, '.gossip', LOCK_FILENAME);
}

function readLockMeta(file: string): LockMetadata | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    if (
      typeof parsed.pid === 'number'
      && Number.isFinite(parsed.pid)
      && typeof parsed.started_at === 'string'
    ) {
      return { pid: parsed.pid, started_at: parsed.started_at };
    }
    return null;
  } catch {
    return null;
  }
}

function tryAcquire(file: string): number | null {
  try {
    // 'wx' = O_CREAT | O_EXCL — atomic create-or-fail
    const fd = fs.openSync(file, 'wx');
    const meta: LockMetadata = {
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    fs.writeSync(fd, JSON.stringify(meta));
    return fd;
  } catch (err: any) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  }
}

function breakStaleLock(file: string): void {
  try {
    const meta = readLockMeta(file);
    fs.unlinkSync(file);
    process.stderr.write(
      `[gossipcat] resolver lock at ${file} was stale (pid=${meta?.pid ?? '?'}, started_at=${meta?.started_at ?? '?'}); breaking\n`,
    );
  } catch { /* race: another process already broke it */ }
}

/**
 * Run `fn` under exclusive resolver lock. Returns `fn`'s value on success,
 * `null` on lock-contention timeout. Errors thrown by `fn` propagate after
 * the lock is released.
 */
export async function withResolverLock<T>(
  projectRoot: string,
  fn: () => Promise<T> | T,
  opts?: { waitMs?: number; pollMs?: number; staleMs?: number },
): Promise<T | null> {
  const file = lockPath(projectRoot);
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }

  const waitMs = opts?.waitMs ?? LOCK_WAIT_MS;
  const pollMs = opts?.pollMs ?? LOCK_POLL_MS;
  const staleMs = opts?.staleMs ?? STALE_LOCK_MS;

  const deadline = Date.now() + waitMs;
  let fd: number | null = null;

  while (true) {
    fd = tryAcquire(file);
    if (fd !== null) break;

    // Lock held — check whether it's stale.
    const meta = readLockMeta(file);
    const startedMs = meta ? new Date(meta.started_at).getTime() : NaN;
    const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : Infinity;
    if (ageMs > staleMs || !meta) {
      breakStaleLock(file);
      // Loop continues — next tryAcquire should succeed unless someone
      // else won the race; if so we'll wait again.
      continue;
    }

    if (Date.now() >= deadline) {
      return null; // contended — caller treats as skipped
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  try {
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch { /* best-effort */ }
    try {
      fs.unlinkSync(file);
    } catch { /* best-effort */ }
  }
}

// Constants exported for tests.
export const RESOLVER_LOCK_INTERNALS = {
  LOCK_FILENAME,
  LOCK_WAIT_MS,
  LOCK_POLL_MS,
  STALE_LOCK_MS,
};
