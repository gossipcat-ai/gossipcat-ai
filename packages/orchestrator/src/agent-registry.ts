/**
 * AgentRegistry — tracks available agents and their skills.
 *
 * Skill matching: count overlapping skills between required and agent's skills.
 * Agent with highest overlap wins.
 */

import { AgentConfig } from './types';

export class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map();

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

  /**
   * Find the agent with the most overlapping skills.
   * Returns null if no agents are registered.
   */
  findBestMatch(requiredSkills: string[]): AgentConfig | null {
    let bestMatch: AgentConfig | null = null;
    let bestScore = 0;

    for (const agent of this.agents.values()) {
      const score = requiredSkills.filter(s => agent.skills.includes(s)).length;
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
