"use strict";
/**
 * TaskDispatcher — decomposes tasks into sub-tasks and assigns agents.
 *
 * Uses LLM to analyze a task and produce a DispatchPlan.
 * Falls back to single sub-task if LLM returns invalid JSON.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskDispatcher = void 0;
const crypto_1 = require("crypto");
class TaskDispatcher {
    llm;
    registry;
    constructor(llm, registry) {
        this.llm = llm;
        this.registry = registry;
    }
    /**
     * Decompose a task into a DispatchPlan using the LLM.
     * On parse failure, falls back to a single sub-task.
     */
    async decompose(task) {
        const availableSkills = this.getAvailableSkills();
        const skillList = availableSkills.length > 0 ? availableSkills.join(', ') : 'general';
        const messages = [
            {
                role: 'system',
                content: `You are a task decomposition engine. Break the user's task into sub-tasks.
For each sub-task, specify required skills from: ${skillList}.
Respond in JSON format:
{
  "strategy": "single" | "parallel" | "sequential",
  "subTasks": [{ "description": "...", "requiredSkills": ["..."] }]
}
If the task is simple enough for one agent, use strategy "single" with one sub-task.`,
            },
            { role: 'user', content: task },
        ];
        const response = await this.llm.generate(messages, { temperature: 0 });
        try {
            const jsonMatch = response.text.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                throw new Error('No JSON in response');
            const plan = JSON.parse(jsonMatch[0]);
            return {
                originalTask: task,
                strategy: plan.strategy || 'single',
                subTasks: (plan.subTasks || []).map((st) => ({
                    id: (0, crypto_1.randomUUID)(),
                    description: st.description,
                    requiredSkills: st.requiredSkills || [],
                    status: 'pending',
                })),
            };
        }
        catch {
            // Fallback: single sub-task with no specific skills
            return {
                originalTask: task,
                strategy: 'single',
                subTasks: [{
                        id: (0, crypto_1.randomUUID)(),
                        description: task,
                        requiredSkills: [],
                        status: 'pending',
                    }],
            };
        }
    }
    /**
     * Assign agents to each sub-task by skill match.
     * Modifies the plan in-place and returns it.
     */
    assignAgents(plan) {
        for (const subTask of plan.subTasks) {
            const match = this.registry.findBestMatch(subTask.requiredSkills);
            if (match) {
                subTask.assignedAgent = match.id;
            }
        }
        return plan;
    }
    /** Collect all unique skills from registered agents */
    getAvailableSkills() {
        const skills = new Set();
        for (const agent of this.registry.getAll()) {
            agent.skills.forEach(s => skills.add(s));
        }
        return Array.from(skills);
    }
}
exports.TaskDispatcher = TaskDispatcher;
//# sourceMappingURL=task-dispatcher.js.map