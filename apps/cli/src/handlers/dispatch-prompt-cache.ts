/**
 * Dispatch-prompt warm cache — Phase 2 of native-dispatch elision.
 * Spec: docs/specs/2026-05-18-dispatch-prompt-warm-cache.md.
 *
 * Same-session, in-memory cache of the assembled skills-section body (the
 * truncatable prefix of `assemblePrompt` output up to the live `\n\nTask:`
 * boundary). On a warm hit, the live `Task:` tail is spliced into the cached
 * skills-section and written to a fresh per-dispatch file — Phase 1's per-task
 * filename + 1h TTL eviction contract is preserved.
 *
 * Iron rules (spec §"Iron rules"):
 *  1. Strict opt-in — only consulted when `prompt_format === 'elided'`.
 *  2. Fingerprint mismatch is fail-safe — drop entry, re-cold.
 *  3. Invalidation is comprehensive — every skill-mutation site must invalidate.
 *  4. No background prune — synchronous LRU on insert.
 *  5. Eviction emits `dispatch_cache_evicted` pipeline signal.
 *  6. SKILLS-SECTION ONLY — the live `Task:` block is spliced in at hit time.
 *     Caching the full body with a stale Task corrupts the RL feedback loop
 *     (consensus 335e8be5-336648b5:f11 CRITICAL).
 */

import { createHash } from 'crypto';
import { statSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

export type TaskKind =
  | 'single'
  | 'parallel-information'
  | 'parallel-consensus'
  | 'consensus-phase1'
  | 'consensus-phase2';

export interface PromptCacheKey {
  agentId: string;
  skillFingerprint: string;
  taskKind: TaskKind;
}

export interface PromptCacheEntry {
  /** Absolute path to the cached SKILLS-SECTION file (NOT a Phase-1 file). */
  skillsSectionPath: string;
  /** Byte length of the cached skills-section body (utf-8). */
  skillsSectionBytes: number;
  createdAtMs: number;
  /** Fingerprint repeated for tamper-detection on read (iron rule §2). */
  skillFingerprint: string;
}

/**
 * Hard cap: 5 task kinds × 7 default agents × ~2 churn slack.
 * LRU eviction by `createdAtMs` on insert beyond cap.
 */
export const DISPATCH_PROMPT_CACHE_MAX_ENTRIES = 64;

/** Module-level cache. Lifetime = MCP server process. */
const promptCache = new Map<string, PromptCacheEntry>();

/**
 * Compute the skill-set fingerprint. SHA-256 of sorted `<absPath>:<mtimeMs>`
 * pairs. Empty array → sha-256 of empty string. Path stat failures cause the
 * pair to be skipped (treated as "skill missing" — next cold load will surface
 * the real error). Symlink dedup is the caller's responsibility — pass
 * realpath-normalized paths (skillResult.paths is already realpath'd at
 * packages/orchestrator/src/skill-loader.ts:418-429).
 */
export function computeSkillFingerprint(paths: string[]): string {
  const pairs: string[] = [];
  for (const p of paths) {
    try {
      const st = statSync(p);
      pairs.push(`${p}:${st.mtimeMs}`);
    } catch {
      // skip missing files — cold path will surface
    }
  }
  pairs.sort();
  return createHash('sha256').update(pairs.join('\n')).digest('hex');
}

export function serializeKey(k: PromptCacheKey): string {
  return `${k.agentId}|${k.skillFingerprint}|${k.taskKind}`;
}

export function getCachedPrompt(k: PromptCacheKey): PromptCacheEntry | null {
  return promptCache.get(serializeKey(k)) ?? null;
}

/**
 * Insert / overwrite a cache entry. Emits `dispatch_cache_evicted` (pipeline)
 * for any eviction. On overwrite of an existing key, fires reason='overwrite_race'
 * (concurrent same-key dispatch — spec §"Concurrent-dispatch race"). On LRU
 * overflow, evicts the eldest by createdAtMs with reason='lru'.
 */
export function setCachedPrompt(k: PromptCacheKey, e: PromptCacheEntry): void {
  const serial = serializeKey(k);
  const existing = promptCache.get(serial);
  if (existing) {
    emitCacheEvictedSignal(k.agentId, 'overwrite_race');
  }
  promptCache.set(serial, e);
  if (promptCache.size > DISPATCH_PROMPT_CACHE_MAX_ENTRIES) {
    // LRU by createdAtMs — find eldest other than the just-inserted entry.
    let oldestKey: string | null = null;
    let oldestMs = Infinity;
    for (const [k2, v2] of promptCache.entries()) {
      if (k2 === serial) continue;
      if (v2.createdAtMs < oldestMs) {
        oldestMs = v2.createdAtMs;
        oldestKey = k2;
      }
    }
    if (oldestKey) {
      const evicted = promptCache.get(oldestKey)!;
      promptCache.delete(oldestKey);
      // The cached skills-section file is a server-internal artifact; best-effort
      // unlink so it doesn't accumulate. Phase-1 dispatch files are unrelated.
      try { unlinkSync(evicted.skillsSectionPath); } catch { /* best-effort */ }
      const evictedAgentId = oldestKey.split('|')[0] ?? '_system';
      emitCacheEvictedSignal(evictedAgentId, 'lru');
    }
  }
}

/**
 * Drop every cache entry for `agentId`. Called from skill-mutation sites
 * (saveFromRaw, writeSkillFileFromParts, gossip_skills develop|bind|unbind,
 * create-agent.ts instruction writes). Returns the count of dropped entries.
 * Emits one `dispatch_cache_evicted` signal per dropped entry (reason='invalidation').
 */
export function invalidateAgent(agentId: string): number {
  let dropped = 0;
  for (const [k, v] of [...promptCache.entries()]) {
    if (k.startsWith(`${agentId}|`)) {
      promptCache.delete(k);
      try { unlinkSync(v.skillsSectionPath); } catch { /* best-effort */ }
      emitCacheEvictedSignal(agentId, 'invalidation');
      dropped++;
    }
  }
  return dropped;
}

/**
 * Drop every entry. Called from gossip_setup mutations (replace/merge/
 * update_instructions). Returns the count of dropped entries.
 */
export function invalidateAll(): number {
  const n = promptCache.size;
  for (const v of promptCache.values()) {
    try { unlinkSync(v.skillsSectionPath); } catch { /* best-effort */ }
  }
  promptCache.clear();
  if (n > 0) {
    emitCacheEvictedSignal('_system', 'invalidation', n);
  }
  return n;
}

/** Test-only — flush state between tests. NOT exported via public API. */
export function __resetForTest(): void {
  promptCache.clear();
}

/** Test-only — inspect current size. */
export function __sizeForTest(): number {
  return promptCache.size;
}

/**
 * Emit a `dispatch_cache_evicted` pipeline signal. Best-effort —
 * failure to emit MUST NOT propagate to the dispatch hot path.
 */
function emitCacheEvictedSignal(
  agentId: string,
  reason: 'lru' | 'invalidation' | 'overwrite_race',
  count: number = 1,
): void {
  // Resolve projectRoot lazily — at module load mcp-context may not be booted.
  // Use require() so the cache file stays import-cycle-free with mcp-context.
  let projectRoot: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ctx } = require('../mcp-context');
    projectRoot = ctx.mainAgent?.projectRoot ?? process.cwd();
  } catch {
    projectRoot = process.cwd();
  }
  // Dynamic import keeps the orchestrator coupling lazy.
  import('@gossip/orchestrator').then(({ emitPipelineSignals }) => {
    try {
      emitPipelineSignals(projectRoot, [{
        type: 'pipeline' as const,
        signal: 'dispatch_cache_evicted',
        agentId,
        taskId: '_system',
        metadata: { reason, count },
        timestamp: new Date().toISOString(),
      }]);
    } catch { /* best-effort */ }
  }).catch(() => { /* best-effort */ });
}

/**
 * Splice helpers — share the boundary contract with dispatch.ts.
 *
 * Splice contract (spec + task description):
 *   - Live `Task:` block = everything from the LAST `\n\nTask:` to end-of-string.
 *   - Cached skills-section = everything BEFORE that boundary.
 *   - Warm-hit body = cachedSkillsSection + extractedLiveTaskBlock.
 *
 * The assembler emits exactly one `\n\n---\n\nTask: ${task}` segment at
 * priority 0 (see packages/orchestrator/src/prompt-assembler.ts:280). The
 * structural lint test in tests/orchestrator/dispatch-prompt-cache.test.ts
 * asserts this invariant.
 */
export interface SplitPromptParts {
  skillsSection: string;
  taskBlock: string;
}

/**
 * Split an assembled prompt into [skills-section, task-block] at the LAST
 * `\n\nTask:` boundary. If the boundary is missing (assembler invariant
 * violated), returns the whole body as skillsSection and an empty taskBlock
 * — caller MUST treat empty taskBlock as fatal and skip caching.
 */
export function splitAssembledPrompt(body: string): SplitPromptParts {
  const idx = body.lastIndexOf('\n\nTask:');
  if (idx < 0) {
    return { skillsSection: body, taskBlock: '' };
  }
  return {
    skillsSection: body.slice(0, idx),
    taskBlock: body.slice(idx),
  };
}

/**
 * Write the cached skills-section to a content-addressed file under
 * .gossip/dispatch-prompts/skills-<fingerprint>.txt. Atomic write-to-temp +
 * rename. Returns absolute path. The file is NOT a Phase-1 dispatch prompt
 * (different filename pattern, separate lifecycle).
 */
export function writeCachedSkillsSection(
  projectRoot: string,
  fingerprint: string,
  skillsSection: string,
): string {
  // Fingerprint is a sha-256 hex string — no SAFE_NAME validation needed.
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error(`writeCachedSkillsSection: invalid fingerprint ${JSON.stringify(fingerprint).slice(0, 32)}`);
  }
  // Sibling subdir keeps the cached skills-section files out of the per-dispatch
  // file-count surface that Phase 1 tests assert against (dispatch-elision.test).
  const dir = join(projectRoot, '.gossip', 'dispatch-prompts', 'cache');
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `skills-${fingerprint}.txt`);
  const tmpPath = join(dir, `skills-${fingerprint}.txt.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(tmpPath, skillsSection, 'utf8');
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
  return resolve(finalPath);
}
