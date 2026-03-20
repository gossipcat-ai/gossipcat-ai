"use strict";
/**
 * AgentRegistry — tracks available agents and their skills.
 *
 * Skill matching: count overlapping skills between required and agent's skills.
 * Agent with highest overlap wins.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRegistry = void 0;
class AgentRegistry {
    agents = new Map();
    /** Register a new agent configuration */
    register(config) {
        this.agents.set(config.id, config);
    }
    /** Remove an agent by ID */
    unregister(id) {
        this.agents.delete(id);
    }
    /** Get agent config by ID */
    get(id) {
        return this.agents.get(id);
    }
    /** Get all registered agents */
    getAll() {
        return Array.from(this.agents.values());
    }
    /**
     * Find the agent with the most overlapping skills.
     * Returns null if no agents are registered.
     */
    findBestMatch(requiredSkills) {
        let bestMatch = null;
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
    findBySkill(skill) {
        return this.getAll().filter(a => a.skills.includes(skill));
    }
    /** Number of registered agents */
    get count() {
        return this.agents.size;
    }
}
exports.AgentRegistry = AgentRegistry;
//# sourceMappingURL=agent-registry.js.map