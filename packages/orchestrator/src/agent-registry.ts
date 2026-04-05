/**
 * AgentRegistry — tracks available agents and their skills.
 *
 * Dispatch matching: (staticOverlap + projectMatchBoost + suggesterBoost) × perfWeight.
 */

import { AgentConfig } from './types';
import { PerformanceReader } from './performance-reader';
import { normalizeSkillName } from './skill-name';
import type { SkillCatalog } from './skill-catalog';

export interface FindBestMatchOptions {
  taskText?: string;
  catalog?: SkillCatalog;
  taskType?: 'review' | 'impl';
  taskCategory?: string;
}

export class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map();
  private perfReader: PerformanceReader | null = null;
  private suggesterCache: Map<string, Set<string>> = new Map();

  register(config: AgentConfig): void {
    this.agents.set(config.id, config);
  }

  unregister(id: string): void {
    this.agents.delete(id);
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  getAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  setPerformanceReader(reader: PerformanceReader): void {
    this.perfReader = reader;
  }

  setSuggesterCache(cache: Map<string, Set<string>>): void {
    this.suggesterCache = cache;
  }

  getDispatchWeight(agentId: string): number {
    if (this.perfReader?.isCircuitOpen(agentId)) return 0.3;
    if (this.perfReader) return this.perfReader.getDispatchWeight(agentId);
    return 1.0;
  }

  findBestMatch(requiredSkills: string[], options?: FindBestMatchOptions): AgentConfig | null {
    return this.findBestMatchExcluding(requiredSkills, new Set(), options);
  }

  /**
   * Find best skill match with additive boosts for project skills.
   * Score = (staticOverlap + projectMatchBoost + suggesterBoost) × perfWeight
   */
  findBestMatchExcluding(
    requiredSkills: string[],
    exclude: Set<string>,
    options?: FindBestMatchOptions,
  ): AgentConfig | null {
    const normalizedRequired = requiredSkills.map(normalizeSkillName);

    // Get project skill matches from task text
    let projectMatches: string[] = [];
    if (options?.taskText && options?.catalog) {
      projectMatches = options.catalog.matchTask(options.taskText)
        .filter(e => e.source === 'project')
        .map(e => e.name);
    }

    let bestMatch: AgentConfig | null = null;
    let bestScore = 0;

    for (const agent of this.agents.values()) {
      if (exclude.has(agent.id)) continue;

      const normalizedAgentSkills = agent.skills.map(normalizeSkillName);

      // 1. Static overlap (existing behavior, normalized)
      const staticOverlap = normalizedRequired.filter(s => normalizedAgentSkills.includes(s)).length;

      // 2. Project match boost — 0.5 per project skill that THIS agent has
      const agentProjectOverlap = projectMatches.filter(s => normalizedAgentSkills.includes(normalizeSkillName(s))).length;
      const projectMatchBoost = agentProjectOverlap * 0.5;

      // 3. Suggester boost — 0.3 if agent suggested any matched project skill
      let suggesterBoost = 0;
      for (const skill of projectMatches) {
        if (this.suggesterCache.get(skill)?.has(agent.id)) {
          suggesterBoost = 0.3;
          break;
        }
      }

      // 4. Category strength boost — if task has a known category, prefer agents strong in it
      let categoryBoost = 0;
      if (options?.taskCategory && this.perfReader) {
        const agentScore = this.perfReader.getAgentScore(agent.id);
        if (agentScore?.categoryStrengths?.[options.taskCategory]) {
          categoryBoost = agentScore.categoryStrengths[options.taskCategory] * 0.5;
        }
      }

      // 5. Performance weight (circuit breaker → reader → neutral)
      let perfWeight = 1.0;
      if (this.perfReader?.isCircuitOpen(agent.id)) {
        perfWeight = 0.3; // circuit breaker overrides all scoring
      } else if (this.perfReader) {
        perfWeight = this.perfReader.getDispatchWeight(agent.id);
      }

      const score = (staticOverlap + projectMatchBoost + suggesterBoost + categoryBoost) * perfWeight;
      // Tiebreaker: prefer agent with higher overlap ratio (more specialized)
      const ratio = agent.skills.length > 0 ? staticOverlap / agent.skills.length : 0;
      const bestRatio = bestMatch && bestMatch.skills.length > 0
        ? normalizedRequired.filter(s => bestMatch!.skills.map(normalizeSkillName).includes(s)).length / bestMatch.skills.length
        : 0;
      if (score > bestScore || (score === bestScore && score > 0 && ratio > bestRatio)) {
        bestScore = score;
        bestMatch = agent;
      }
    }

    return bestMatch;
  }

  findBySkill(skill: string): AgentConfig[] {
    const normalized = normalizeSkillName(skill);
    return this.getAll().filter(a => a.skills.map(normalizeSkillName).includes(normalized));
  }

  get count(): number {
    return this.agents.size;
  }
}
