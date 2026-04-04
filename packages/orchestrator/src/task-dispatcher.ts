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
import { DispatchPlan, PlannedTask } from './types';

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
        content: `You are a task decomposition engine. Break work into tasks that use the FULL team.

## Available skills: ${skillList}

## Rules

1. **Decompose by file scope.** Split implementation into 3-5 tasks, each owning a non-overlapping set of files or directories. One task = one scope.

2. **Use the full team in parallel.** If researchers and reviewers are available, give them work alongside implementers:
   - Researcher: investigate APIs, find examples, check docs — runs in parallel with implementation
   - Reviewer: review the completed code — runs after implementation (sequential)

3. **Describe WHAT, not HOW.** The agent decides file structure, components, architecture.

4. **3-5 tasks max.** Typical patterns:
   - Small feature → single implementer (1 task)
   - Medium feature → 2-3 scoped implementers in parallel
   - Large feature → 3-5 scoped implementers + researcher + reviewer
   - Each implementation task should specify its file scope (e.g., "packages/relay/src/dashboard/")

## Response format

Respond in JSON:
{
  "strategy": "single" | "parallel" | "sequential",
  "subTasks": [{ "description": "...", "requiredSkills": ["..."] }]
}

"single" = one task. "parallel" = all tasks run at same time. "sequential" = tasks run in order.
Use "sequential" ONLY when a later task genuinely needs output from an earlier one AND they need different skills.`,
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
    // Track assigned agents to avoid duplicates in parallel plans
    const assigned = new Set<string>();

    for (const subTask of plan.subTasks) {
      // For parallel plans, prefer agents not yet assigned
      const match = plan.strategy === 'parallel'
        ? this.registry.findBestMatchExcluding(subTask.requiredSkills, assigned)
          || this.registry.findBestMatch(subTask.requiredSkills)  // fallback: allow reuse
        : this.registry.findBestMatch(subTask.requiredSkills);

      if (match) {
        subTask.assignedAgent = match.id;
        assigned.add(match.id);
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

  /**
   * Classify each sub-task as read or write and suggest write modes.
   * Falls back to all-read on LLM failure.
   */
  async classifyWriteModes(plan: DispatchPlan): Promise<PlannedTask[]> {
    const subTaskList = plan.subTasks
      .map((st, i) => `${i}. [agent: ${st.assignedAgent || 'unassigned'}] ${st.description}`)
      .join('\n');

    try {
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `Classify each sub-task as read-only or write. For write tasks, suggest a write mode and scope.

Rules:
- Tasks with action verbs (fix, implement, add, create, refactor, update, delete, write, build, migrate) → write
- Tasks with observation verbs (review, analyze, check, verify, list, explain, summarize, audit, trace) → read
- Research/investigation tasks → read (even if they save a report)
- If the task mentions a specific directory → write_mode: scoped, scope: that directory
- If the task is broad (full project) → write_mode: scoped, scope: "./"
- NEVER use write_mode: sequential for parallel plans — it will fail
- NEVER use write_mode: worktree

Respond as JSON array:
[{ "index": 0, "access": "write", "write_mode": "scoped", "scope": "./" }, { "index": 1, "access": "read" }]`,
        },
        { role: 'user', content: `Sub-tasks:\n${subTaskList}` },
      ];

      const response = await this.llm.generate(messages, { temperature: 0 });
      const jsonMatch = response.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array in response');

      const classifications = JSON.parse(jsonMatch[0]) as Array<{
        index: number;
        access: 'read' | 'write';
        write_mode?: string;
        scope?: string;
      }>;

      const validModes = new Set(['sequential', 'scoped', 'worktree']);
      return plan.subTasks.map((st, i) => {
        const c = classifications.find(cl => cl.index === i);
        const isWrite = c?.access === 'write';
        const mode = isWrite && c?.write_mode && validModes.has(c.write_mode)
          ? c.write_mode as PlannedTask['writeMode']
          : undefined;
        return {
          agentId: st.assignedAgent || '',
          task: st.description,
          access: isWrite ? 'write' as const : 'read' as const,
          writeMode: mode,
          scope: isWrite ? c?.scope : undefined,
        };
      });
    } catch {
      // Fallback: all read-only
      return plan.subTasks.map(st => ({
        agentId: st.assignedAgent || '',
        task: st.description,
        access: 'read' as const,
      }));
    }
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
