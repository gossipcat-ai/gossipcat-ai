/**
 * TaskDispatcher — decomposes tasks into sub-tasks and assigns agents.
 *
 * Uses LLM to analyze a task and produce a DispatchPlan.
 * Falls back to single sub-task if LLM returns invalid JSON.
 */
import { ILLMProvider } from './llm-client';
import { AgentRegistry } from './agent-registry';
import { DispatchPlan } from './types';
export declare class TaskDispatcher {
    private llm;
    private registry;
    constructor(llm: ILLMProvider, registry: AgentRegistry);
    /**
     * Decompose a task into a DispatchPlan using the LLM.
     * On parse failure, falls back to a single sub-task.
     */
    decompose(task: string): Promise<DispatchPlan>;
    /**
     * Assign agents to each sub-task by skill match.
     * Modifies the plan in-place and returns it.
     */
    assignAgents(plan: DispatchPlan): DispatchPlan;
    /** Collect all unique skills from registered agents */
    private getAvailableSkills;
}
