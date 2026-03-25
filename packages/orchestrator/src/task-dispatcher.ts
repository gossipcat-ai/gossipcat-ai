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
        content: `You are a task decomposition engine. Decide whether a task should be handled as a single unit or broken into sub-tasks.

## WHEN TO USE "single" (ONE task, ONE agent)

Most tasks should be "single". Use it when:
- The project can be built by one developer in one sitting (a small app, a landing page, a CLI tool, a game)
- The task involves creating a cohesive thing where splitting it would cause conflicting decisions (e.g. one agent picks TypeScript while another picks JavaScript)
- The task is under ~10 files
- There's no natural boundary between independent pieces

Examples that should be "single":
- "Build a snake game" → single (one agent builds the whole game)
- "Create a music app with a grid and audio" → single (it's one cohesive app)
- "Add a login page with form validation" → single
- "Build a REST API for todos" → single
- "Create a landing page" → single

## WHEN TO SPLIT into sub-tasks

Only split when there are genuinely independent workstreams that benefit from parallelism or different expertise:
- Implementation + review (different skills needed)
- Implementation + research (can run in parallel)
- Backend API + frontend UI (truly independent, different directories)
- Multiple independent microservices

When you DO split:
- Each sub-task must be fully self-contained — it must make ALL technology decisions for its scope
- NEVER split by file type (HTML/CSS/JS separately) — that forces agents to make isolated decisions that conflict
- NEVER split implementation into sequential steps where step N depends on step N-1's exact output
- Aim for 2-3 sub-tasks. More than 4 is almost always wrong.

## Task descriptions

Describe WHAT to build, not HOW. The agent decides implementation details (components, hooks, file structure). Good: "Build a music grid app with audio playback and scale selection using React + Vite." Bad: "Create an App component with useState for grid state, a Grid component using useRef for canvas..."

## Response format

For each sub-task, specify required skills from: ${skillList}.
Respond in JSON format:
{
  "strategy": "single" | "parallel" | "sequential",
  "subTasks": [{ "description": "...", "requiredSkills": ["..."] }]
}
Use "single" for most tasks (one agent handles everything).
Use "parallel" when sub-tasks are truly independent (different directories, no shared state).
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
- If the task mentions a specific directory or package path → write_mode: scoped, scope: that path
- If the task is broad with no clear directory boundary → write_mode: sequential
- NEVER use write_mode: worktree — it requires a git repository and adds complexity. Use sequential instead.

Respond as JSON array:
[{ "index": 0, "access": "write", "write_mode": "scoped", "scope": "packages/tools/" }, { "index": 1, "access": "read" }]`,
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
