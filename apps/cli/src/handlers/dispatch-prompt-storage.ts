/**
 * Dispatch prompt storage — Option B (server-side prompt elision).
 *
 * Stores native dispatch prompts on disk under .gossip/dispatch-prompts/<taskId>.txt
 * so the MCP `gossip_dispatch`/`gossip_run`/`gossip_collect` response payload can
 * omit the AGENT_PROMPT content item entirely when the caller opted in via
 * `prompt_format: 'elided'`. The orchestrator must Read the cited file and
 * forward its contents verbatim to Agent(prompt: ...).
 *
 * Iron rules from spec docs/specs/2026-05-18-native-dispatch-skill-handle-pattern.md:
 *   - Strict opt-in: server elides ONLY on explicit request. Default behavior
 *     (inline AGENT_PROMPT content items) is unchanged.
 *   - On-disk file contains ONLY the agent-facing prompt — no relay_token,
 *     no task_id orchestration metadata.
 *   - Atomic write-to-temp + rename. SAFE_NAME validation on taskId.
 *   - mtime-keyed eviction (default 1h) + aggregate eldest-eviction at 100MB cap.
 *   - Crash recovery: on boot, prune orphan files whose taskId is not present
 *     in the restored nativeTaskMap.
 */

import { mkdirSync, renameSync, statSync, readdirSync, unlinkSync, writeFileSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { randomUUID } from 'crypto';

/**
 * SAFE_NAME — alphanumerics plus `._-`, no `..` substring, ≤64 chars.
 * Mirrors packages/orchestrator/src/skill-engine.ts SAFE_NAME pattern but is
 * locally re-declared to avoid a cross-package import in the CLI handler tier.
 * Reject empties, dots-only, and any traversal attempt.
 */
const SAFE_TASK_ID = /^(?!.*\.\.)[A-Za-z0-9._-]{1,64}$/;

/** Aggregate storage cap. Beyond this, evict eldest by mtime until under cap. */
export const DISPATCH_PROMPT_CAP_BYTES = 100 * 1024 * 1024;

/** Default mtime-based eviction window — 1 hour. */
export const DEFAULT_PROMPT_TTL_MS = 60 * 60 * 1000;

/** Subdirectory under .gossip/ where dispatch prompts live. */
export const DISPATCH_PROMPTS_SUBDIR = 'dispatch-prompts';

function dispatchPromptsDir(projectRoot: string): string {
  return join(projectRoot, '.gossip', DISPATCH_PROMPTS_SUBDIR);
}

/**
 * Validate a taskId is safe for use as a filename. Throws on any violation
 * — callers ALWAYS supply a taskId they just minted via randomUUID().slice,
 * so a violation here indicates a logic bug, not user input.
 */
function assertSafeTaskId(taskId: string): void {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('dispatch-prompt-storage: taskId must be a non-empty string');
  }
  if (!SAFE_TASK_ID.test(taskId)) {
    throw new Error(`dispatch-prompt-storage: taskId failed SAFE_NAME validation (rejected: ${JSON.stringify(taskId).slice(0, 64)})`);
  }
}

/**
 * Write a dispatch prompt to disk and return its absolute path.
 *
 * Atomic: writes to <taskId>.txt.<rand>.tmp then renames into place. On
 * rename failure the temp file is best-effort cleaned up.
 *
 * Caller is responsible for ensuring `body` contains ONLY the agent-facing
 * prompt — no relay_token, no AGENT_PROMPT tag prefix, no orchestration
 * metadata. Stored verbatim.
 */
export function writeDispatchPrompt(projectRoot: string, taskId: string, body: string): string {
  assertSafeTaskId(taskId);
  const dir = dispatchPromptsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${taskId}.txt`);
  const tmpPath = join(dir, `${taskId}.txt.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(tmpPath, body, 'utf8');
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
  return resolve(finalPath);
}

/**
 * Synchronously evict prompt files older than `maxAgeMs` (default 1h)
 * by mtime. Then enforce the aggregate `DISPATCH_PROMPT_CAP_BYTES` cap by
 * removing eldest entries until the remaining total is under cap.
 *
 * Fail-open: any single-file stat/unlink error is logged to stderr and the
 * loop continues. The directory not existing is a no-op success.
 */
export function cleanupExpiredDispatchPrompts(
  projectRoot: string,
  maxAgeMs: number = DEFAULT_PROMPT_TTL_MS,
  capBytes: number = DISPATCH_PROMPT_CAP_BYTES,
): { evictedAge: number; evictedCap: number } {
  const dir = dispatchPromptsDir(projectRoot);
  if (!existsSync(dir)) return { evictedAge: 0, evictedCap: 0 };
  const now = Date.now();
  let entries: Array<{ name: string; path: string; mtimeMs: number; size: number }> = [];
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        entries.push({ name, path, mtimeMs: st.mtimeMs, size: st.size });
      } catch (err) {
        process.stderr.write(`[gossipcat] dispatch-prompt stat failed for ${basename(path)}: ${(err as Error).message}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] dispatch-prompt readdir failed: ${(err as Error).message}\n`);
    return { evictedAge: 0, evictedCap: 0 };
  }

  let evictedAge = 0;
  const survivors: typeof entries = [];
  for (const e of entries) {
    if (now - e.mtimeMs > maxAgeMs) {
      try { unlinkSync(e.path); evictedAge++; }
      catch (err) { process.stderr.write(`[gossipcat] dispatch-prompt unlink failed for ${e.name}: ${(err as Error).message}\n`); }
    } else {
      survivors.push(e);
    }
  }

  let totalBytes = survivors.reduce((acc, e) => acc + e.size, 0);
  let evictedCap = 0;
  if (totalBytes > capBytes) {
    // Eldest-first eviction until under cap.
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of survivors) {
      if (totalBytes <= capBytes) break;
      try {
        unlinkSync(e.path);
        totalBytes -= e.size;
        evictedCap++;
      } catch (err) {
        process.stderr.write(`[gossipcat] dispatch-prompt cap-evict failed for ${e.name}: ${(err as Error).message}\n`);
      }
    }
  }
  return { evictedAge, evictedCap };
}

/**
 * Crash-recovery orphan prune. Called at MCP boot AFTER nativeTaskMap is
 * restored. Removes any prompt file whose taskId no longer matches a known
 * task — these are residual writes from a crashed previous session.
 *
 * `knownTaskIds` is the set of taskIds restored into ctx.nativeTaskMap.
 * Files for unknown taskIds are unlinked. Files older than `maxAgeMs`
 * are evicted regardless (matches existing TTL semantics).
 */
export function pruneOrphanDispatchPrompts(
  projectRoot: string,
  knownTaskIds: Set<string>,
  maxAgeMs: number = DEFAULT_PROMPT_TTL_MS,
): { orphans: number; aged: number } {
  const dir = dispatchPromptsDir(projectRoot);
  if (!existsSync(dir)) return { orphans: 0, aged: 0 };
  const now = Date.now();
  let orphans = 0;
  let aged = 0;
  try {
    for (const name of readdirSync(dir)) {
      // Only consider final .txt files; temp files get the regular cleanup pass.
      if (!name.endsWith('.txt')) continue;
      const taskId = name.slice(0, -4);
      const path = join(dir, name);
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
      const tooOld = now - mtimeMs > maxAgeMs;
      const orphaned = !knownTaskIds.has(taskId);
      if (tooOld || orphaned) {
        try {
          unlinkSync(path);
          if (orphaned) orphans++;
          else aged++;
        } catch (err) {
          process.stderr.write(`[gossipcat] dispatch-prompt orphan-prune failed for ${name}: ${(err as Error).message}\n`);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] dispatch-prompt orphan-readdir failed: ${(err as Error).message}\n`);
  }
  return { orphans, aged };
}

/**
 * Test-helper: resolve the absolute path a given taskId WOULD be written to,
 * without performing any IO. Used by the elision unit tests and any future
 * crash-recovery diagnostics. Validates SAFE_NAME so callers don't paper
 * over a bug by reading from a path that would have been rejected on write.
 */
export function dispatchPromptPath(projectRoot: string, taskId: string): string {
  assertSafeTaskId(taskId);
  return resolve(join(dispatchPromptsDir(projectRoot), `${taskId}.txt`));
}
