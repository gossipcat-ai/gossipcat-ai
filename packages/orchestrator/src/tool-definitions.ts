/**
 * @gossip/orchestrator — Tool schemas, constants, and system prompt builder
 * for cognitive orchestration mode.
 */

export interface ToolSchema {
  description: string;
  requiredArgs: string[];
  optionalArgs?: string[];
}

export const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  dispatch: {
    description: 'Send a task to a specific agent.',
    requiredArgs: ['agent_id', 'task'],
  },
  dispatch_parallel: {
    description: 'Send tasks to multiple agents in parallel.',
    requiredArgs: ['tasks'],
  },
  dispatch_consensus: {
    description: 'Send a task for cross-review consensus among agents.',
    requiredArgs: ['task'],
    optionalArgs: ['agent_ids'],
  },
  plan: {
    description: 'Create an execution plan for a complex task.',
    requiredArgs: ['task'],
  },
  agents: {
    description: 'List all registered agents and their skills.',
    requiredArgs: [],
  },
  agent_status: {
    description: 'Get the current status of a specific agent.',
    requiredArgs: ['agent_id'],
  },
  agent_performance: {
    description: 'Show performance metrics for all agents.',
    requiredArgs: [],
  },
  update_instructions: {
    description: 'Update runtime instructions for one or more agents.',
    requiredArgs: ['agent_ids', 'instruction'],
    optionalArgs: ['mode'],
  },
  read_task_history: {
    description: 'Read past task results for an agent.',
    requiredArgs: ['agent_id'],
    optionalArgs: ['limit'],
  },
  init_project: {
    description: 'Initialize project with a tailored agent team based on project type',
    requiredArgs: ['description'],
    optionalArgs: ['archetype'],
  },
  update_team: {
    description: 'Add, remove, or modify an agent in the team (requires confirmation)',
    requiredArgs: ['action'],
    optionalArgs: ['agent_id', 'preset', 'skills'],
  },
};

export const PLAN_CHOICES = {
  EXECUTE: 'plan_execute',
  MODIFY: 'plan_modify',
  CANCEL: 'plan_cancel',
} as const;

export const PENDING_PLAN_CHOICES = {
  DISCARD: 'discard_and_replan',
  EXECUTE_PENDING: 'execute_pending',
  CANCEL: 'cancel',
} as const;

/**
 * Build the system prompt section describing available tools.
 * Agent list is NOT duplicated here — the bootstrap prompt already has it.
 */
export function buildToolSystemPrompt(
  _agents: Array<{ id: string; preset?: string; skills: string[] }>,
): string {
  const toolLines = Object.entries(TOOL_SCHEMAS).map(([name, schema]) => {
    const args = schema.requiredArgs.length
      ? ` (${schema.requiredArgs.join(', ')}${schema.optionalArgs ? ', ' + schema.optionalArgs.map(a => `${a}?`).join(', ') : ''})`
      : schema.optionalArgs
        ? ` (${schema.optionalArgs.map(a => `${a}?`).join(', ')})`
        : '';
    return `- **${name}**${args} — ${schema.description}`;
  });

  return `## Available Tools

See the team context above for available agents.

${toolLines.join('\n')}

init_project(description: string, archetype?: string)
  Initialize this project with a tailored agent team. Scans directory for signals,
  proposes agents based on project type. Use when no agents are configured.

update_team(action: "add" | "remove" | "modify", agent_id?: string, preset?: string, skills?: string[])
  Modify the agent team. Requires user confirmation before applying.
  Use when user wants to add, remove, or change an agent.

## How to Call Tools

When you need to use a tool, emit a tool call block:

\`\`\`
[TOOL_CALL]
tool: <tool_name>
args:
  key: value
\`\`\`

## When Uncertain

If you are unsure which action to take, present options using:

\`\`\`
[CHOICES]
message: "<question for the developer>"
options:
  - value: "option_a"
    label: "Option A"
  - value: "option_b"
    label: "Option B"
\`\`\``;
}
