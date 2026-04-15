import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, sep } from 'path';
import type { SkillIndex } from './skill-index';
import { parseSkillFrontmatter } from './skill-parser';
import { normalizeSkillName } from './skill-name';
import { gossipLog, log as _log } from './log';

const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const MAX_CONTEXTUAL_SKILLS = 3;
/**
 * Fractional boost added to a contextual skill's raw hit count when its
 * `category` frontmatter is in the task's extracted categories. Chosen as 0.5
 * to preserve integer-tie semantics against raw hits:
 *   - non-category 2-hit (2.0) still beats category 1-hit (1.5)
 *   - category 1-hit (1.5) beats non-category 1-hit (1.0)
 *   - 0 raw hits + boost (0.5) does NOT pass MIN_KEYWORD_HITS=1 threshold
 * See consensus f2ff0fac-fb384daa for the pinned design.
 */
const CATEGORY_BOOST = 0.5;
// Lowered from 2 → 1 (consensus c8977bda-37564212): cross-cutting skills
// (citation_grounding, error_handling) starved on well-framed tasks where
// only a single keyword matched. MAX_CONTEXTUAL_SKILLS=3 remains the budget
// safety net — hit count still orders candidates, so low-signal matches lose
// to stronger ones and only fill the remaining slots when nothing else wins.
const MIN_KEYWORD_HITS = 1;

/** Default keyword sets by category — used when skill frontmatter has no explicit keywords */
export const DEFAULT_KEYWORDS: Record<string, string[]> = {
  trust_boundaries: ['auth', 'authentication', 'authorization', 'session', 'cookie', 'token', 'path', 'traversal', 'injection', 'middleware', 'permission', 'role', 'privilege', 'acl'],
  injection_vectors: ['injection', 'xss', 'sql', 'sanitize', 'escape', 'template', 'eval', 'exec', 'html', 'uri', 'command'],
  input_validation: ['validation', 'schema', 'zod', 'parse', 'sanitize', 'input', 'form', 'request', 'coerce', 'transform'],
  concurrency: ['race condition', 'concurrent', 'mutex', 'lock', 'atomic', 'parallel', 'deadlock', 'semaphore'],
  resource_exhaustion: ['memory', 'leak', 'unbounded', 'growth', 'limit', 'cap', 'timeout', 'pool', 'cache', 'backpressure', 'buffer', 'queue', 'throttle'],
  type_safety: ['type guard', 'generic', 'cast', 'assertion', 'narrowing', 'discriminated', 'satisfies'],
  error_handling: ['error handling', 'catch', 'throw', 'exception', 'retry', 'fallback', 'recovery', 'graceful'],
  data_integrity: ['data integrity', 'migration', 'serialize', 'deserialize', 'corrupt', 'consistency', 'invariant', 'transaction', 'rollback', 'idempotent'],
  // Fabrication-class failures: agent cites code that does not match repo state.
  // Kept in sync with CATEGORY_KEYWORDS in skill-engine.ts — both tables drive contextual activation
  // and auto-inference in gossip_signals, so they must agree.
  citation_grounding: ['cite', 'citation', 'line number', 'anchor', 'file path', 'reference', 'fabricat', 'hallucin', 'verify', 'does not exist', 'no such'],
};

export interface DroppedSkill {
  skill: string;
  reason:
    | 'status-failed'
    | 'status-silent'
    | 'below-keyword-threshold'
    | 'no-task-provided'
    | 'budget-exceeded'
    /**
     * Skill declared `task_type` that does not match the dispatch's inferred
     * type (e.g. a review-only skill on an implement dispatch). Evaluated
     * BEFORE keyword-hit threshold and category boost so mismatched skills
     * never consume the contextual budget.
     */
    | 'task-type-mismatch';
  hits: number;
}

export interface LoadSkillsResult {
  content: string;
  loaded: string[];
  /**
   * Structured drop records. Every skill that was considered but not injected
   * appears here with the reason. Closes the silent-drop observability gap
   * where contextual skills with `task` undefined were previously skipped
   * without appearing in `loaded` OR `dropped`.
   */
  dropped: DroppedSkill[];
  activatedContextual: string[];
}

/**
 * Compute the category match boost for a contextual skill.
 * Returns CATEGORY_BOOST (0.5) if the skill's category is in the task's
 * extracted categories, otherwise 0. Zero-category tasks always return 0.
 */
function categoryBoost(skillCategory: string | undefined, categories: string[]): number {
  if (!skillCategory || categories.length === 0) return 0;
  return categories.includes(skillCategory) ? CATEGORY_BOOST : 0;
}

/**
 * Load skill files for an agent and return structured result.
 *
 * Resolution order per skill:
 * 1. Agent's local skills: .gossip/agents/<id>/skills/
 * 2. Project skills: .gossip/skills/
 * 3. Default skills: packages/orchestrator/src/default-skills/
 *
 * Permanent skills are always loaded. Contextual skills require MIN_KEYWORD_HITS
 * (word-boundary match) against the task string, capped at MAX_CONTEXTUAL_SKILLS.
 *
 * When `taskCategories` is provided, skills whose frontmatter `category` is in
 * that array receive a fractional boost (CATEGORY_BOOST) applied to raw hits
 * BEFORE the threshold gate. A 0-hit skill with boost 0.5 still fails the
 * MIN_KEYWORD_HITS=1 gate (effective 0.5 < 1). A 1-hit skill with boost gets
 * 1.5 effective hits — enough to outrank a non-category 1-hit but not a
 * non-category 2-hit. See consensus f2ff0fac-fb384daa.
 */
export function loadSkills(
  agentId: string,
  skills: string[],
  projectRoot: string,
  index?: SkillIndex,
  task?: string,
  taskCategories?: string[],
  /**
   * Dispatch task type. When provided, skills whose frontmatter `task_type`
   * is set to a CONCRETE type ('review'|'implement'|'research') that does
   * not match are hard-rejected with `task-type-mismatch` BEFORE the
   * keyword-hit gate. Skills with `task_type: 'any'` (the default for
   * unlabelled skills) are unaffected, preserving backwards-compat.
   *
   * When undefined, the filter is skipped entirely (same as pre-migration
   * behaviour) — call sites that don't yet know the dispatch type retain
   * today's semantics.
   */
  dispatchTaskType?: 'review' | 'implement' | 'research',
): LoadSkillsResult {
  const effectiveSkills = index && index.getAgentSlots(agentId).length > 0
    ? index.getEnabledSkills(agentId)
    : skills;

  const categories = taskCategories ?? [];

  const permanent: Array<{ name: string; content: string }> = [];
  const contextualCandidates: Array<{ name: string; content: string; hits: number; rawHits: number; boost: number }> = [];
  const loaded: string[] = [];
  const dropped: DroppedSkill[] = [];
  const activatedContextual: string[] = [];

  for (const skill of effectiveSkills) {
    const content = resolveSkill(agentId, skill, projectRoot);
    if (!content) continue;

    // Filter by skill effectiveness status written by checkEffectiveness().
    // 'failed' and 'silent_skill' are suppressed — injecting a skill the RL loop
    // has marked as harmful or silent would re-pollute the forward pass.
    const frontmatterStatus = parseSkillFrontmatter(content)?.status;
    if (frontmatterStatus === 'failed' || frontmatterStatus === 'silent_skill') {
      gossipLog(`Skipping ${frontmatterStatus} skill ${agentId}/${skill} from injection`);
      dropped.push({
        skill,
        reason: frontmatterStatus === 'failed' ? 'status-failed' : 'status-silent',
        hits: 0,
      });
      continue;
    }
    if (frontmatterStatus === 'flagged_for_manual_review') {
      gossipLog(`Injecting flagged_for_manual_review skill ${agentId}/${skill} — manual review recommended`);
    }

    // Task-type axis filter. Evaluated BEFORE keyword-hit counting and the
    // contextual budget, so a mismatched skill never starves a valid one
    // out of the MAX_CONTEXTUAL_SKILLS slots. Skills without an explicit
    // task_type parse to 'any' (see skill-parser coercion), which passes
    // the gate for every dispatch — backwards-compat by default.
    if (dispatchTaskType) {
      const skillTaskType = parseSkillFrontmatter(content)?.task_type ?? 'any';
      if (skillTaskType !== 'any' && skillTaskType !== dispatchTaskType) {
        dropped.push({ skill, reason: 'task-type-mismatch', hits: 0 });
        continue;
      }
    }

    const mode = index?.getSkillMode(agentId, skill) ?? 'permanent';

    if (mode === 'permanent') {
      permanent.push({ name: skill, content });
    } else if (task) {
      const rawHits = countKeywordHits(content, skill, task);
      const frontmatter = parseSkillFrontmatter(content);
      const boost = categoryBoost(frontmatter?.category, categories);
      const effectiveHits = rawHits + boost;
      // Threshold applied to effective hits. With CATEGORY_BOOST=0.5 and
      // MIN_KEYWORD_HITS=1, a 0-hit skill with boost still fails (0.5 < 1)
      // but a 1-hit skill with boost passes (1.5 >= 1) and outranks plain
      // 1-hit candidates during the descending sort below.
      if (effectiveHits >= MIN_KEYWORD_HITS) {
        contextualCandidates.push({ name: skill, content, hits: effectiveHits, rawHits, boost });
      } else {
        // Report raw hits so operators see the real keyword-match count; boost
        // already failed to rescue, so recording effective hits would hide the
        // fact that the skill had 0 keyword matches.
        dropped.push({ skill, reason: 'below-keyword-threshold', hits: rawHits });
      }
    } else {
      // No task provided — record the silent drop so it shows up in observability
      // instead of vanishing between loaded and dropped.
      dropped.push({ skill, reason: 'no-task-provided', hits: 0 });
    }
  }

  // Sort contextual by effective hit count (descending), with alphabetical
  // name as a deterministic tiebreaker. Node's Array.sort has been stable
  // since v12, but relying on input order here would leak skill-index
  // iteration order into activation decisions — the name tiebreaker makes
  // ties deterministic regardless of discovery order.
  contextualCandidates.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.name.localeCompare(b.name);
  });
  const accepted = contextualCandidates.slice(0, MAX_CONTEXTUAL_SKILLS);
  const rejected = contextualCandidates.slice(MAX_CONTEXTUAL_SKILLS);

  for (const s of permanent) loaded.push(s.name);
  for (const s of accepted) {
    loaded.push(s.name);
    activatedContextual.push(s.name);
  }
  for (const s of rejected) dropped.push({ skill: s.name, reason: 'budget-exceeded', hits: s.hits });

  // Strip delimiter strings from skill content to prevent prompt injection
  const sanitizeContent = (c: string) => c.replace(/---\s*END SKILLS\s*---/gi, '--- END-SKILLS ---');
  const sections = [
    ...permanent.map(s => sanitizeContent(s.content)),
    ...accepted.map(s => sanitizeContent(s.content)),
  ];

  const contentStr = sections.length > 0
    ? '\n\n--- SKILLS ---\n\n' + sections.join('\n\n---\n\n') + '\n\n--- END SKILLS ---\n\n'
    : '';

  return { content: contentStr, loaded, dropped, activatedContextual };
}

/** Cache compiled regex patterns to avoid per-dispatch recompilation */
const patternCache = new Map<string, RegExp>();
const MAX_PATTERN_CACHE = 500;
const MAX_KEYWORD_LENGTH = 100;

function getPattern(keyword: string): RegExp {
  const capped = keyword.slice(0, MAX_KEYWORD_LENGTH);
  const cached = patternCache.get(capped);
  if (cached !== undefined) {
    // LRU: delete-then-set promotes this key to most-recently-used position.
    // Without this, Map insertion order made eviction FIFO despite the LRU name,
    // so hot keywords could be evicted while cold ones survived.
    patternCache.delete(capped);
    patternCache.set(capped, cached);
    return cached;
  }
  if (patternCache.size >= MAX_PATTERN_CACHE) {
    // Evict least-recently-used entry (first in iteration order after LRU promotion)
    const first = patternCache.keys().next().value;
    if (first !== undefined) patternCache.delete(first);
  }
  const escaped = capped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
  patternCache.set(capped, pattern);
  return pattern;
}

/**
 * Count keyword hits for a contextual skill against a task string.
 * Uses word-boundary matching to prevent false positives (e.g., "auth" won't match "author").
 */
function countKeywordHits(skillContent: string, skillName: string, task: string): number {
  const keywords = getKeywords(skillContent, skillName);
  if (keywords.length === 0) return 0;

  let hits = 0;
  for (const keyword of keywords) {
    if (getPattern(keyword).test(task)) hits++;
  }
  return hits;
}

/**
 * Extract keywords from skill frontmatter or fall back to category defaults.
 */
function getKeywords(content: string, skillName: string): string[] {
  const frontmatter = parseSkillFrontmatter(content);
  if (frontmatter?.keywords && frontmatter.keywords.length > 0) {
    return frontmatter.keywords.map(k => k.toLowerCase());
  }
  if (frontmatter?.category && DEFAULT_KEYWORDS[frontmatter.category]) {
    return DEFAULT_KEYWORDS[frontmatter.category];
  }
  // Fallback: skill name as single keyword. With MIN_KEYWORD_HITS=1, this
  // fallback IS reachable — a skill with broken frontmatter will fire
  // whenever its filename word appears in the task. Warn loudly so missing
  // keywords/category surface quickly instead of silently activating on
  // tenuous filename matches. Per bench review 12827629-fa9a4660:f2 and
  // cross-review 5ad115dd-fbc14d01:f6.
  _log('skill-loader', `WARNING: skill '${skillName}' has no keywords/category frontmatter — contextual activation will fail (using filename fallback)`);
  return [skillName.replace(/-/g, ' ')];
}

function resolveSkill(agentId: string, skill: string, projectRoot: string): string | null {
  // Sanitize agentId to prevent path traversal
  if (!SAFE_AGENT_ID.test(agentId)) return null;

  // Use canonical normalization for skill name (consistent with SkillIndex)
  const normalized = normalizeSkillName(skill);
  if (!normalized) return null;
  const filename = `${normalized}.md`;

  const bases = [
    resolve(projectRoot, '.gossip', 'agents', agentId, 'skills'),
    resolve(projectRoot, '.gossip', 'skills'),
    resolve(__dirname, 'default-skills'),
  ];

  for (const base of bases) {
    const candidate = resolve(base, filename);
    // Validate resolved path stays within base directory
    if (!candidate.startsWith(base + sep)) continue;
    if (existsSync(candidate)) {
      // Guard against permission errors, I/O failures, corrupted files.
      // Per bench review 12827629-fa9a4660:f1, an unguarded readFileSync here
      // propagated uncaught through dispatch handlers and could crash the
      // entire gossip_dispatch call. Now we log and fall through to the next
      // base (or return null) instead.
      try {
        return readFileSync(candidate, 'utf-8');
      } catch (err: any) {
        _log('skill-loader', `Failed to read skill file ${candidate}: ${err?.message ?? err}`);
        continue;
      }
    }
  }
  return null;
}

/** Check if a skill file exists in any resolution path (without reading content). */
export function resolveSkillExists(agentId: string, skill: string, projectRoot: string): boolean {
  return resolveSkill(agentId, skill, projectRoot) !== null;
}

/**
 * Test-only handle for LRU cache behavior verification. Not part of the public
 * API — consumers should not rely on this shape. Exposed so tests can assert
 * eviction order without duplicating the module-scoped cache.
 */
export const __lruInternals = {
  patternCache,
  getPattern,
  MAX_PATTERN_CACHE,
};

/**
 * List available skills for an agent (from all sources, deduplicated).
 */
export function listAvailableSkills(agentId: string, projectRoot: string): string[] {
  const skills = new Set<string>();

  const defaultDir = resolve(__dirname, 'default-skills');
  if (existsSync(defaultDir)) {
    for (const f of readdirSync(defaultDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  const projectDir = resolve(projectRoot, '.gossip', 'skills');
  if (existsSync(projectDir)) {
    for (const f of readdirSync(projectDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  if (!SAFE_AGENT_ID.test(agentId)) return Array.from(skills).sort();
  const agentDir = resolve(projectRoot, '.gossip', 'agents', agentId, 'skills');
  if (existsSync(agentDir)) {
    for (const f of readdirSync(agentDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  return Array.from(skills).sort();
}
