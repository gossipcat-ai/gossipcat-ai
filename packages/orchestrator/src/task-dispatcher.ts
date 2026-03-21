/**
 * TaskDispatcher — decomposes tasks into sub-tasks and assigns agents.
 *
 * Uses LLM to analyze a task and produce a DispatchPlan.
 * Falls back to single sub-task if LLM returns invalid JSON.
 */

import { randomUUID } from 'crypto';
import { LLMMessage } from '@gossip/types';
import { ILLMProvider } from './llm-client';
import { AgentRegistry } from './agent-registry';
import { DispatchPlan } from './types';

export class TaskDispatcher {
  constructor(
    private llm: ILLMProvider,
    private registry: AgentRegistry
  ) {}

  /**
   * Decompose a task into a DispatchPlan using the LLM.
   * On parse failure, falls back to a single sub-task.
   */
  async decompose(task: string): Promise<DispatchPlan> {
    const availableSkills = this.getAvailableSkills();
    const skillList = availableSkills.length > 0 ? availableSkills.join(', ') : 'general';

    const messages: LLMMessage[] = [
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
      if (!jsonMatch) throw new Error('No JSON in response');
      const plan = JSON.parse(jsonMatch[0]);

      return {
        originalTask: task,
        strategy: plan.strategy || 'single',
        subTasks: (plan.subTasks || []).map((st: { description: string; requiredSkills?: string[] }) => ({
          id: randomUUID(),
          description: st.description,
          requiredSkills: st.requiredSkills || [],
          status: 'pending' as const,
        })),
        warnings: [],
      };
    } catch {
      // Fallback: single sub-task with no specific skills
      return {
        originalTask: task,
        strategy: 'single',
        subTasks: [{
          id: randomUUID(),
          description: task,
          requiredSkills: [],
          status: 'pending' as const,
        }],
        warnings: [],
      };
    }
  }

  /**
   * Assign agents to each sub-task by skill match.
   * Modifies the plan in-place and returns it.
   * Populates plan.warnings for any required skill with no matching agent.
   */
  assignAgents(plan: DispatchPlan): DispatchPlan {
    if (!plan.warnings) plan.warnings = [];
    for (const subTask of plan.subTasks) {
      const match = this.registry.findBestMatch(subTask.requiredSkills);
      if (match) {
        subTask.assignedAgent = match.id;
      } else {
        for (const skill of subTask.requiredSkills) {
          const hasAgent = this.registry.findBySkill(skill).length > 0;
          if (!hasAgent) {
            plan.warnings.push(
              `Skill '${skill}' is required but no agent has it assigned. ` +
              `Add it to an agent's skills in gossip.agents.json.`
            );
          }
        }
      }
    }
    return plan;
  }

  /** Collect all unique skills from registered agents */
  private getAvailableSkills(): string[] {
    const skills = new Set<string>();
    for (const agent of this.registry.getAll()) {
      agent.skills.forEach(s => skills.add(s));
    }
    return Array.from(skills);
  }
}
