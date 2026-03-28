/**
 * AgentRegistry — tracks available agents and their skills.
 *
 * Dispatch matching: (staticOverlap + projectMatchBoost + suggesterBoost) × perfWeight.
 */
import { AgentConfig } from './types';
import { PerformanceReader } from './performance-reader';
import { CompetencyProfiler } from './competency-profiler';
import type { SkillCatalog } from './skill-catalog';
export interface FindBestMatchOptions {
    taskText?: string;
    catalog?: SkillCatalog;
}
export declare class AgentRegistry {
    private agents;
    private perfReader;
    private competencyProfiler;
    private suggesterCache;
    register(config: AgentConfig): void;
    unregister(id: string): void;
    get(id: string): AgentConfig | undefined;
    getAll(): AgentConfig[];
    setPerformanceReader(reader: PerformanceReader): void;
    setCompetencyProfiler(profiler: CompetencyProfiler): void;
    setSuggesterCache(cache: Map<string, Set<string>>): void;
    findBestMatch(requiredSkills: string[], options?: FindBestMatchOptions): AgentConfig | null;
    /**
     * Find best skill match with additive boosts for project skills.
     * Score = (staticOverlap + projectMatchBoost + suggesterBoost) × perfWeight
     */
    findBestMatchExcluding(requiredSkills: string[], exclude: Set<string>, options?: FindBestMatchOptions): AgentConfig | null;
    findBySkill(skill: string): AgentConfig[];
    get count(): number;
}
