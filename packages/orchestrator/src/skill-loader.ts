import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Load skill files for an agent and return concatenated content
 * for prompt injection.
 *
 * Resolution order:
 * 1. Agent's local skills: .gossip/agents/<id>/skills/
 * 2. Project skills: .gossip/skills/
 * 3. Default skills: packages/orchestrator/src/default-skills/
 */
export function loadSkills(agentId: string, skills: string[], projectRoot: string): string {
  const sections: string[] = [];

  for (const skill of skills) {
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
  const filename = `${skill}.md`;

  // 1. Agent's local skills
  const agentPath = resolve(projectRoot, '.gossip', 'agents', agentId, 'skills', filename);
  if (existsSync(agentPath)) return readFileSync(agentPath, 'utf-8');

  // 2. Project-wide skills
  const projectPath = resolve(projectRoot, '.gossip', 'skills', filename);
  if (existsSync(projectPath)) return readFileSync(projectPath, 'utf-8');

  // 3. Default skills (bundled)
  const defaultPath = resolve(__dirname, 'default-skills', filename);
  if (existsSync(defaultPath)) return readFileSync(defaultPath, 'utf-8');

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
