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
    description: 'Send a task to one agent and wait for the result. Use for single-agent work: quick implementations, file reads, running tests, simple lookups. Pass write_mode ("sequential"|"scoped"|"worktree") and scope (directory path) when the agent needs to modify files.',
    requiredArgs: ['agent_id', 'task'],
    optionalArgs: ['write_mode', 'scope'],
  },
  dispatch_parallel: {
    description: 'Fan out tasks to multiple agents simultaneously and collect all results. Use for: code reviews (split by concern), security audits (split by package), bug investigation (one hypothesis per agent), feature implementation (split by module with scoped write modes). Each task item is { agent_id, task, write_mode?, scope? }.',
    requiredArgs: ['tasks'],
  },
  dispatch_consensus: {
    description: 'Dispatch the same task to multiple agents, then cross-review their findings for consensus. Each agent reviews peer output and produces agree/disagree/new judgments. Returns a tagged report (CONFIRMED/DISPUTED/UNIQUE/NEW). Use for: code reviews, security audits, architecture reviews — any task where cross-validation catches what single reviewers miss. Defaults to all agents if agent_ids not specified.',
    requiredArgs: ['task'],
    optionalArgs: ['agent_ids'],
  },
  spec: {
    description: 'Generate a project spec document from the brainstorming conversation. Saves to .gossip/spec.md for user review. The spec captures: goal, tech stack, features, and constraints. Use this AFTER brainstorming and BEFORE plan. The user reviews and can edit the spec before proceeding.',
    requiredArgs: ['task'],
  },
  plan: {
    description: 'Decompose a task into agent-dispatchable subtasks. If a spec exists (.gossip/spec.md), use it as the source of truth. Returns a structured plan for approval before dispatching.',
    requiredArgs: ['task'],
  },
  agents: {
    description: 'List all registered agents with their provider, model, role, and skills. Use to check who is available before dispatching.',
    requiredArgs: [],
  },
  agent_status: {
    description: 'Get recent task history and current state for a specific agent. Shows last 5 tasks with warmth scores. Use to check if an agent is idle or overloaded.',
    requiredArgs: ['agent_id'],
  },
  agent_performance: {
    description: 'Show consensus performance signals for all agents — agreement rates, disputed findings, unique contributions. Use to understand agent strengths and inform future dispatch decisions.',
    requiredArgs: [],
  },
  update_instructions: {
    description: 'Update runtime instructions for one or more agents (requires developer confirmation). Use to steer agent behavior mid-session: add coding standards, focus areas, or constraints. Mode: "append" (default) adds to existing instructions, "replace" overwrites them.',
    requiredArgs: ['agent_ids', 'instruction'],
    optionalArgs: ['mode'],
  },
  read_task_history: {
    description: 'Read past task results for an agent. Returns task descriptions, warmth scores, and timestamps. Use to understand what an agent has been working on and how well it performed.',
    requiredArgs: ['agent_id'],
    optionalArgs: ['limit'],
  },
  init_project: {
    description: 'Initialize this project with a tailored agent team. Scans the project directory for language, framework, and structure signals, then proposes an archetype-matched team (e.g., game-dev, web-app, library). Use when no agents are configured yet. Requires developer confirmation before applying.',
    requiredArgs: ['description'],
    optionalArgs: ['archetype'],
  },
  setup: {
    description: 'Alias for init_project. Set up or re-propose the agent team for this project.',
    requiredArgs: ['description'],
    optionalArgs: ['archetype'],
  },
  update_team: {
    description: 'Add, remove, or modify an agent in the team (requires developer confirmation). Actions: "add" creates a new agent with a preset and skills, "remove" removes an agent by ID, "modify" changes skills or preset of an existing agent.',
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

/** Convert TOOL_SCHEMAS to native ToolDefinition[] for API function calling */
export function getOrchestratorToolDefinitions(): import('@gossip/types').ToolDefinition[] {
  const argType = (name: string): { type: string; description: string } => {
    if (name === 'tasks') return { type: 'string', description: 'JSON array of {agent_id, task, write_mode?, scope?}' };
    if (name === 'agent_ids') return { type: 'string', description: 'JSON array of agent IDs' };
    if (name === 'task') return { type: 'string', description: 'Task description' };
    if (name === 'agent_id') return { type: 'string', description: 'Agent ID' };
    if (name === 'write_mode') return { type: 'string', description: 'Write mode: sequential, scoped, or worktree' };
    if (name === 'scope') return { type: 'string', description: 'Directory scope for scoped writes' };
    if (name === 'description') return { type: 'string', description: 'Project description' };
    if (name === 'instruction') return { type: 'string', description: 'Instruction text' };
    if (name === 'limit') return { type: 'string', description: 'Max entries to return' };
    if (name === 'action') return { type: 'string', description: 'Action: add, remove, or modify' };
    if (name === 'preset') return { type: 'string', description: 'Agent preset' };
    if (name === 'skills') return { type: 'string', description: 'Comma-separated skills' };
    return { type: 'string', description: name };
  };

  return Object.entries(TOOL_SCHEMAS).map(([name, schema]) => {
    const properties: Record<string, { type: string; description: string }> = {};
    for (const arg of schema.requiredArgs) properties[arg] = argType(arg);
    for (const arg of schema.optionalArgs || []) properties[arg] = argType(arg);
    return {
      name,
      description: schema.description,
      parameters: { type: 'object' as const, properties, required: schema.requiredArgs },
    };
  });
}

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

  // Build explicit agent ID list so LLM uses exact IDs
  const agentList = _agents.length > 0
    ? _agents.map(a => `- **${a.id}** (${a.preset || 'custom'}) — skills: ${a.skills.join(', ')}`).join('\n')
    : 'No agents configured yet. Use init_project to set up a team.';

  return `## Agents
${agentList}

## Tools
${toolLines.join('\n')}

Call format: [TOOL_CALL]{"tool":"name","args":{"key":"value"}}[/TOOL_CALL]`;
}
