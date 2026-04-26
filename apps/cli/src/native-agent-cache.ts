/**
 * Native agent in-memory cache refresh helper.
 *
 * Extracted from doSyncWorkers (mcp-server-sdk.ts) so the read-from-disk +
 * cache-set behavior is testable in isolation. The previous inline version
 * was guarded with `!ctx.nativeAgentConfigs.has(ac.id)` — that meant once an
 * agent was bootstrapped into the cache, subsequent gossip_setup merge calls
 * would rewrite .claude/agents/<id>.md on disk but the in-memory cache stayed
 * stale, and dispatch kept emitting the old AGENT_PROMPT. The fix is to
 * re-read from disk and update the cache unconditionally on every sync.
 *
 * Keeping this as a pure function (with `fs` and `path` injected via the
 * thin wrappers below) means a unit test can exercise the refresh-on-update
 * invariant without mocking the entire syncWorkersViaKeychain pipeline
 * (MainAgent, keychain, identityRegistry, workers, mainProvider mirror).
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface NativeAgentCacheEntry {
  model: string;
  instructions: string;
  description: string;
  skills: string[];
  /**
   * Modification time (ms since epoch) of the source-of-truth file the
   * `instructions` value was last read from (.claude/agents/<id>.md when
   * present, the .gossip fallback otherwise). Used by refreshNativeAgentFromDisk
   * to skip the readFileSync when the file is unchanged since the last refresh.
   * Undefined when the entry was created from a disk-empty state (no source
   * file exists), so the next refresh always re-attempts the read.
   */
  cachedMtimeMs?: number;
}

export interface NativeAgentInput {
  id: string;
  model: string;
  role?: string;
  preset?: string;
  skills?: string[];
}

export interface FsLike {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: 'utf-8') => string;
  /**
   * mtime in ms since epoch for the given path. Wrapped in the FsLike
   * interface so unit tests can drive the mtime-skip path deterministically
   * without touching the real filesystem.
   */
  statSync: (p: string) => { mtimeMs: number };
}

const realFs: FsLike = {
  existsSync,
  readFileSync,
  statSync: (p: string) => ({ mtimeMs: statSync(p).mtimeMs }),
};

/**
 * Map a model id to a Claude tier label. Mirrors the inline logic that was
 * previously duplicated across the bootstrap and config-sync paths.
 */
export function modelTierFromId(modelId: string): 'opus' | 'sonnet' | 'haiku' {
  if (modelId.includes('opus')) return 'opus';
  if (modelId.includes('haiku')) return 'haiku';
  return 'sonnet';
}

/**
 * Refresh the in-memory cache entry for a single native agent from its
 * on-disk source of truth (.claude/agents/<id>.md, or
 * .gossip/agents/<id>/instructions.md as fallback).
 *
 * Frontmatter is stripped from the .claude/agents/<id>.md content. The
 * fallback .gossip/agents/<id>/instructions.md is consumed as-is.
 *
 * Three guards address regressions identified during PR #266 review:
 *
 *  1. **mtime skip (perf)**: if the source file's mtime equals the cached
 *     entry's `cachedMtimeMs`, the readFileSync is skipped and the existing
 *     entry is preserved. Closes the "refresh storm" where every dispatch
 *     triggered N synchronous file reads even when nothing had changed.
 *
 *  2. **empty-file clobber guard**: if the on-disk file exists but yields an
 *     empty `instructions` string after frontmatter strip + trim, AND a
 *     non-empty cached entry already exists, the cached value is preserved.
 *     Closes the race where doSyncWorkers reads .claude/agents/<id>.md mid-
 *     write (file truncated to 0 bytes by the writer), which would otherwise
 *     overwrite a previously-good entry with an empty system prompt.
 *
 *  3. **missing-file clobber guard**: if neither source file exists AND a
 *     non-empty cached entry already exists, the cached value is preserved.
 *     Closes the race where doSyncWorkers reads .claude/agents/<id>.md
 *     during the brief window when the writer has unlinked the old file
 *     and not yet renamed the temp file into place (atomic-replace pattern).
 *
 * Backward-compat: if neither source file exists AND no cached entry exists,
 * the cache is set with empty `instructions` — matches the prior inline
 * behavior so downstream code does not see an undefined entry for a
 * config-defined native agent that has not yet been written to disk.
 */
export function refreshNativeAgentFromDisk(
  ac: NativeAgentInput,
  cache: Map<string, NativeAgentCacheEntry>,
  projectRoot: string,
  fs: FsLike = realFs
): void {
  const claudeAgentPath = join(projectRoot, '.claude', 'agents', `${ac.id}.md`);
  const instrPath = join(projectRoot, '.gossip', 'agents', ac.id, 'instructions.md');
  const prev = cache.get(ac.id);

  // Determine which source file to consult, in preference order.
  let sourcePath: string | null = null;
  let stripFrontmatter = false;
  if (fs.existsSync(claudeAgentPath)) {
    sourcePath = claudeAgentPath;
    stripFrontmatter = true;
  } else if (fs.existsSync(instrPath)) {
    sourcePath = instrPath;
    stripFrontmatter = false;
  }

  // Guard 3: missing-file clobber — neither source exists, but we have a
  // good cached entry. Preserve it rather than overwriting with ''.
  if (sourcePath === null) {
    if (prev && prev.instructions.length > 0) {
      return;
    }
    // No prior good entry: preserve backward compat by writing an empty
    // entry so downstream code can find SOMETHING for a config-defined agent.
    cache.set(ac.id, {
      model: modelTierFromId(ac.model),
      instructions: '',
      description: ac.role || ac.preset || '',
      skills: ac.skills || [],
      // No cachedMtimeMs — next refresh will always retry the read.
    });
    return;
  }

  // Guard 1: mtime skip — file is unchanged since last refresh.
  // statSync is cheap (single inode lookup) compared to readFileSync of
  // a multi-KB instructions file, especially on networked filesystems.
  let currentMtimeMs: number;
  try {
    currentMtimeMs = fs.statSync(sourcePath).mtimeMs;
  } catch {
    // If statSync fails (race with delete between existsSync and statSync),
    // fall through to the missing-file guard logic — preserve prev if good,
    // else write empty entry.
    if (prev && prev.instructions.length > 0) {
      return;
    }
    cache.set(ac.id, {
      model: modelTierFromId(ac.model),
      instructions: '',
      description: ac.role || ac.preset || '',
      skills: ac.skills || [],
    });
    return;
  }
  if (prev && prev.cachedMtimeMs === currentMtimeMs) {
    return;
  }

  // Read the source file.
  let instructions = fs.readFileSync(sourcePath, 'utf-8');
  if (stripFrontmatter) {
    instructions = instructions.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
  }

  // Guard 2: empty-file clobber — the read produced an empty string but a
  // good cached entry exists. Likely a mid-write race (writer truncated the
  // file to 0 bytes before writing new content).
  if (instructions.length === 0 && prev && prev.instructions.length > 0) {
    return;
  }

  cache.set(ac.id, {
    model: modelTierFromId(ac.model),
    instructions,
    description: ac.role || ac.preset || '',
    skills: ac.skills || [],
    cachedMtimeMs: currentMtimeMs,
  });
}
