"use strict";
/**
 * AgentRegistry — tracks available agents and their skills.
 *
 * Dispatch matching: (staticOverlap + projectMatchBoost + suggesterBoost) × perfWeight.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRegistry = void 0;
const skill_name_1 = require("./skill-name");
class AgentRegistry {
    agents = new Map();
    perfReader = null;
    competencyProfiler = null;
    suggesterCache = new Map();
    register(config) {
        this.agents.set(config.id, config);
    }
    unregister(id) {
        this.agents.delete(id);
    }
    get(id) {
        return this.agents.get(id);
    }
    getAll() {
        return Array.from(this.agents.values());
    }
    setPerformanceReader(reader) {
        this.perfReader = reader;
    }
    setCompetencyProfiler(profiler) {
        this.competencyProfiler = profiler;
    }
    setSuggesterCache(cache) {
        this.suggesterCache = cache;
    }
    findBestMatch(requiredSkills, options) {
        return this.findBestMatchExcluding(requiredSkills, new Set(), options);
    }
    /**
     * Find best skill match with additive boosts for project skills.
     * Score = (staticOverlap + projectMatchBoost + suggesterBoost) × perfWeight
     */
    findBestMatchExcluding(requiredSkills, exclude, options) {
        const normalizedRequired = requiredSkills.map(skill_name_1.normalizeSkillName);
        // Get project skill matches from task text
        let projectMatches = [];
        if (options?.taskText && options?.catalog) {
            projectMatches = options.catalog.matchTask(options.taskText)
                .filter(e => e.source === 'project')
                .map(e => e.name);
        }
        let bestMatch = null;
        let bestScore = 0;
        for (const agent of this.agents.values()) {
            if (exclude.has(agent.id))
                continue;
            const normalizedAgentSkills = agent.skills.map(skill_name_1.normalizeSkillName);
            // 1. Static overlap (existing behavior, normalized)
            const staticOverlap = normalizedRequired.filter(s => normalizedAgentSkills.includes(s)).length;
            // 2. Project match boost — 0.5 per matched project skill
            const projectMatchBoost = projectMatches.length * 0.5;
            // 3. Suggester boost — 0.3 if agent suggested any matched project skill
            let suggesterBoost = 0;
            for (const skill of projectMatches) {
                if (this.suggesterCache.get(skill)?.has(agent.id)) {
                    suggesterBoost = 0.3;
                    break;
                }
            }
            // 4. Performance weight
            // Prefer competency profiler if available (richer scoring)
            let perfWeight = 1.0;
            if (this.competencyProfiler) {
                perfWeight = this.competencyProfiler.getProfileMultiplier(agent.id, 'review');
            }
            else if (this.perfReader) {
                perfWeight = this.perfReader.getDispatchWeight(agent.id);
            }
            const score = (staticOverlap + projectMatchBoost + suggesterBoost) * perfWeight;
            // Tiebreaker: prefer agent with higher overlap ratio (more specialized)
            const ratio = agent.skills.length > 0 ? staticOverlap / agent.skills.length : 0;
            const bestRatio = bestMatch && bestMatch.skills.length > 0
                ? normalizedRequired.filter(s => bestMatch.skills.map(skill_name_1.normalizeSkillName).includes(s)).length / bestMatch.skills.length
                : 0;
            if (score > bestScore || (score === bestScore && score > 0 && ratio > bestRatio)) {
                bestScore = score;
                bestMatch = agent;
            }
        }
        return bestMatch;
    }
    findBySkill(skill) {
        const normalized = (0, skill_name_1.normalizeSkillName)(skill);
        return this.getAll().filter(a => a.skills.map(skill_name_1.normalizeSkillName).includes(normalized));
    }
    get count() {
        return this.agents.size;
    }
}
exports.AgentRegistry = AgentRegistry;
//# sourceMappingURL=agent-registry.js.map