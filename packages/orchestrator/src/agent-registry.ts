/**
 * AgentRegistry — tracks available agents and their skills.
 *
 * Skill matching: count overlapping skills × performance weight.
 * Agent with highest weighted score wins.
 */

import { AgentConfig } from './types';
import { PerformanceReader } from './performance-reader';

export class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map();
  private perfReader: PerformanceReader | null = null;

  /** Register a new agent configuration */
  register(config: AgentConfig): void {
    this.agents.set(config.id, config);
  }

  /** Remove an agent by ID */
  unregister(id: string): void {
    this.agents.delete(id);
  }

  /** Get agent config by ID */
  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  /** Get all registered agents */
  getAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  /** Set performance reader for dispatch weighting */
  setPerformanceReader(reader: PerformanceReader): void {
    this.perfReader = reader;
  }

  /**
   * Find the agent with the most overlapping skills, weighted by performance.
   * Returns null if no agents are registered.
   */
  findBestMatch(requiredSkills: string[]): AgentConfig | null {
    return this.findBestMatchExcluding(requiredSkills, new Set());
  }

  /** Find best skill match, excluding agents in the given set.
   *  Score = skillOverlap × performanceWeight (0.5-1.5) */
  findBestMatchExcluding(requiredSkills: string[], exclude: Set<string>): AgentConfig | null {
    let bestMatch: AgentConfig | null = null;
    let bestScore = 0;

    for (const agent of this.agents.values()) {
      if (exclude.has(agent.id)) continue;
      const skillScore = requiredSkills.filter(s => agent.skills.includes(s)).length;
      const perfWeight = this.perfReader?.getDispatchWeight(agent.id) ?? 1.0;
      const score = skillScore * perfWeight;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = agent;
      }
    }

    return bestMatch;
  }

  /** Find all agents that have a given skill */
  findBySkill(skill: string): AgentConfig[] {
    return this.getAll().filter(a => a.skills.includes(skill));
  }

  /** Number of registered agents */
  get count(): number {
    return this.agents.size;
  }
}
