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

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface NativeAgentCacheEntry {
  model: string;
  instructions: string;
  description: string;
  skills: string[];
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
}

const realFs: FsLike = { existsSync, readFileSync };

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
 * .gossip/agents/<id>/instructions.md as fallback). Idempotent and
 * unconditional — call on every sync; the read+set runs even when the
 * agent already has an entry, because that is the whole point of the fix.
 *
 * Frontmatter is stripped from the .claude/agents/<id>.md content. The
 * fallback .gossip/agents/<id>/instructions.md is consumed as-is.
 *
 * If neither file exists, the cache is set with empty instructions —
 * matches the previous inline behavior so downstream code does not see
 * an undefined entry for a config-defined native agent.
 */
export function refreshNativeAgentFromDisk(
  ac: NativeAgentInput,
  cache: Map<string, NativeAgentCacheEntry>,
  projectRoot: string,
  fs: FsLike = realFs
): void {
  const claudeAgentPath = join(projectRoot, '.claude', 'agents', `${ac.id}.md`);
  const instrPath = join(projectRoot, '.gossip', 'agents', ac.id, 'instructions.md');

  let instructions = '';
  if (fs.existsSync(claudeAgentPath)) {
    instructions = fs
      .readFileSync(claudeAgentPath, 'utf-8')
      .replace(/^---\n[\s\S]*?\n---\n*/, '')
      .trim();
  } else if (fs.existsSync(instrPath)) {
    instructions = fs.readFileSync(instrPath, 'utf-8');
  }

  cache.set(ac.id, {
    model: modelTierFromId(ac.model),
    instructions,
    description: ac.role || ac.preset || '',
    skills: ac.skills || [],
  });
}
