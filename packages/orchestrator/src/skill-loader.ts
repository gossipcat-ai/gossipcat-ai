import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, sep } from 'path';
import type { SkillIndex } from './skill-index';

/**
 * Load skill files for an agent and return concatenated content
 * for prompt injection.
 *
 * Resolution order:
 * 1. Agent's local skills: .gossip/agents/<id>/skills/
 * 2. Project skills: .gossip/skills/
 * 3. Default skills: packages/orchestrator/src/default-skills/
 *
 * If a SkillIndex is provided, uses its enabled skills as source of truth
 * (filtering out disabled slots). Falls back to skills[] when no index.
 */
export function loadSkills(agentId: string, skills: string[], projectRoot: string, index?: SkillIndex): string {
  // Use index as source of truth when available and agent has slots
  const effectiveSkills = index && index.getAgentSlots(agentId).length > 0
    ? index.getEnabledSkills(agentId)
    : skills;

  const sections: string[] = [];

  for (const skill of effectiveSkills) {
    const content = resolveSkill(agentId, skill, projectRoot);
    if (content) {
      sections.push(content);
    }
  }

  return sections.length > 0
    ? '\n\n--- SKILLS ---\n\n' + sections.join('\n\n---\n\n') + '\n\n--- END SKILLS ---\n\n'
    : '';
}

function resolveSkill(agentId: string, skill: string, projectRoot: string): string | null {
  // Sanitize: only allow alphanumeric, hyphens, underscores
  const sanitized = skill.replace(/[^a-z0-9_-]/gi, '');
  if (!sanitized) return null;
  const filename = `${sanitized}.md`;
  const hyphenFilename = `${sanitized.replace(/_/g, '-')}.md`;

  const bases = [
    resolve(projectRoot, '.gossip', 'agents', agentId, 'skills'),
    resolve(projectRoot, '.gossip', 'skills'),
    resolve(__dirname, 'default-skills'),
  ];

  for (const base of bases) {
    for (const fname of [filename, hyphenFilename]) {
      const candidate = resolve(base, fname);
      if (!candidate.startsWith(base + sep)) continue;
      if (existsSync(candidate)) return readFileSync(candidate, 'utf-8');
    }
  }
  return null;
}

/**
 * List available skills for an agent (from all sources, deduplicated).
 */
export function listAvailableSkills(agentId: string, projectRoot: string): string[] {
  const skills = new Set<string>();

  // Default skills
  const defaultDir = resolve(__dirname, 'default-skills');
  if (existsSync(defaultDir)) {
    for (const f of readdirSync(defaultDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  // Project skills
  const projectDir = resolve(projectRoot, '.gossip', 'skills');
  if (existsSync(projectDir)) {
    for (const f of readdirSync(projectDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  // Agent local skills
  const agentDir = resolve(projectRoot, '.gossip', 'agents', agentId, 'skills');
  if (existsSync(agentDir)) {
    for (const f of readdirSync(agentDir)) {
      if (f.endsWith('.md')) skills.add(f.replace('.md', ''));
    }
  }

  return Array.from(skills).sort();
}
