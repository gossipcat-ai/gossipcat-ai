/**
 * AgentRegistry — tracks available agents and their skills.
 *
 * Skill matching: count overlapping skills between required and agent's skills.
 * Agent with highest overlap wins.
 */
import { AgentConfig } from './types';
export declare class AgentRegistry {
    private agents;
    /** Register a new agent configuration */
    register(config: AgentConfig): void;
    /** Remove an agent by ID */
    unregister(id: string): void;
    /** Get agent config by ID */
    get(id: string): AgentConfig | undefined;
    /** Get all registered agents */
    getAll(): AgentConfig[];
    /**
     * Find the agent with the most overlapping skills.
     * Returns null if no agents are registered.
     */
    findBestMatch(requiredSkills: string[]): AgentConfig | null;
    /** Find all agents that have a given skill */
    findBySkill(skill: string): AgentConfig[];
    /** Number of registered agents */
    get count(): number;
}
