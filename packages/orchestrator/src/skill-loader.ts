import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, sep } from 'path';
import type { SkillIndex } from './skill-index';
import { parseSkillFrontmatter } from './skill-parser';
import { normalizeSkillName } from './skill-name';

const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const MAX_CONTEXTUAL_SKILLS = 3;
const MIN_KEYWORD_HITS = 2;

/** Default keyword sets by category — used when skill frontmatter has no explicit keywords */
const DEFAULT_KEYWORDS: Record<string, string[]> = {
  trust_boundaries: ['auth', 'authentication', 'authorization', 'session', 'cookie', 'token', 'path', 'traversal', 'injection', 'middleware', 'permission', 'role', 'privilege', 'acl'],
  injection_vectors: ['injection', 'xss', 'sql', 'sanitize', 'escape', 'template', 'eval', 'exec', 'html', 'uri', 'command'],
  input_validation: ['validation', 'schema', 'zod', 'parse', 'sanitize', 'input', 'form', 'request', 'coerce', 'transform'],
  concurrency: ['race condition', 'concurrent', 'mutex', 'lock', 'atomic', 'parallel', 'deadlock', 'semaphore'],
  resource_exhaustion: ['memory', 'leak', 'unbounded', 'growth', 'limit', 'cap', 'timeout', 'pool', 'cache', 'backpressure', 'buffer', 'queue', 'throttle'],
  type_safety: ['type guard', 'generic', 'cast', 'assertion', 'narrowing', 'discriminated', 'satisfies'],
  error_handling: ['error handling', 'catch', 'throw', 'exception', 'retry', 'fallback', 'recovery', 'graceful'],
  data_integrity: ['data integrity', 'migration', 'serialize', 'deserialize', 'corrupt', 'consistency', 'invariant', 'transaction', 'rollback', 'idempotent'],
};

export interface LoadSkillsResult {
  content: string;
  loaded: string[];
  dropped: string[];
  activatedContextual: string[];
}

/**
 * Load skill files for an agent and return structured result.
 *
 * Resolution order per skill:
 * 1. Agent's local skills: .gossip/agents/<id>/skills/
 * 2. Project skills: .gossip/skills/
 * 3. Default skills: packages/orchestrator/src/default-skills/
 *
 * Permanent skills are always loaded. Contextual skills require 2+ keyword
 * hits (word-boundary match) against the task string, capped at MAX_CONTEXTUAL_SKILLS.
 */
export function loadSkills(agentId: string, skills: string[], projectRoot: string, index?: SkillIndex, task?: string): LoadSkillsResult {
  const effectiveSkills = index && index.getAgentSlots(agentId).length > 0
    ? index.getEnabledSkills(agentId)
    : skills;

  const permanent: Array<{ name: string; content: string }> = [];
  const contextualCandidates: Array<{ name: string; content: string; hits: number }> = [];
  const loaded: string[] = [];
  const dropped: string[] = [];
  const activatedContextual: string[] = [];

  for (const skill of effectiveSkills) {
    const content = resolveSkill(agentId, skill, projectRoot);
    if (!content) continue;

    const mode = index?.getSkillMode(agentId, skill) ?? 'permanent';

    if (mode === 'permanent') {
      permanent.push({ name: skill, content });
    } else if (task) {
      const hits = countKeywordHits(content, skill, task);
      if (hits >= MIN_KEYWORD_HITS) {
        contextualCandidates.push({ name: skill, content, hits });
      }
    }
    // If no task provided, contextual skills are skipped (nothing to match against)
  }

  // Sort contextual by hit count (descending), apply budget
  contextualCandidates.sort((a, b) => b.hits - a.hits);
  const accepted = contextualCandidates.slice(0, MAX_CONTEXTUAL_SKILLS);
  const rejected = contextualCandidates.slice(MAX_CONTEXTUAL_SKILLS);

  for (const s of permanent) loaded.push(s.name);
  for (const s of accepted) {
    loaded.push(s.name);
    activatedContextual.push(s.name);
  }
  for (const s of rejected) dropped.push(s.name);

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
  let pattern = patternCache.get(capped);
  if (!pattern) {
    if (patternCache.size >= MAX_PATTERN_CACHE) {
      // Evict oldest entry (first inserted)
      const first = patternCache.keys().next().value;
      if (first !== undefined) patternCache.delete(first);
    }
    const escaped = capped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    patternCache.set(capped, pattern);
  }
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
  // Fallback: skill name as single keyword (unlikely to hit 2-match minimum alone)
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
    if (existsSync(candidate)) return readFileSync(candidate, 'utf-8');
  }
  return null;
}

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
