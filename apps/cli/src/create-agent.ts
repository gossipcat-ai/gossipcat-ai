import * as p from '@clack/prompts';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Keychain } from './keychain';

// ── Provider + Model catalog (shared with setup-wizard) ─────────────────────
const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai',    label: 'OpenAI (GPT)' },
  { value: 'google',    label: 'Google (Gemini)' },
  { value: 'local',     label: 'Local (Ollama)' },
] as const;

const MODELS: Record<string, Array<{ value: string; label: string; hint?: string }>> = {
  anthropic: [
    { value: 'claude-opus-4-6',   label: 'Claude Opus 4.6',   hint: 'Most capable' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',  hint: 'Fast + smart' },
    { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',   hint: 'Fastest' },
  ],
  openai: [
    { value: 'gpt-5',       label: 'GPT-5',       hint: 'Most capable' },
    { value: 'gpt-4o',      label: 'GPT-4o',      hint: 'Fast + smart' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini', hint: 'Fastest' },
    { value: 'o3',          label: 'o3',           hint: 'Reasoning' },
    { value: 'o3-mini',     label: 'o3-mini',      hint: 'Fast reasoning' },
  ],
  google: [
    { value: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro',   hint: 'Most capable' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'Fast' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', hint: 'Stable' },
  ],
};

const PRESETS = [
  { value: 'architect',   label: 'Architect',   hint: 'Design, decompose, review trade-offs' },
  { value: 'implementer', label: 'Implementer', hint: 'Write code, build features' },
  { value: 'reviewer',    label: 'Reviewer',    hint: 'Find bugs, security, quality' },
  { value: 'tester',      label: 'Tester',      hint: 'Write tests, verify, coverage' },
  { value: 'researcher',  label: 'Researcher',  hint: 'Read docs, gather context' },
  { value: 'debugger',    label: 'Debugger',    hint: 'Investigate errors, root cause' },
  { value: 'custom',      label: 'Custom',      hint: 'Define your own role' },
];

const PRESET_SKILLS: Record<string, string[]> = {
  architect:   ['typescript', 'system_design', 'code_review', 'api_design'],
  implementer: ['typescript', 'implementation', 'testing', 'react'],
  reviewer:    ['code_review', 'security_audit', 'debugging'],
  tester:      ['testing', 'debugging', 'e2e', 'integration'],
  researcher:  ['documentation', 'api_design', 'research'],
  debugger:    ['debugging', 'testing', 'code_review'],
};

const AVAILABLE_SKILLS = [
  { value: 'typescript',     label: 'TypeScript' },
  { value: 'python',         label: 'Python' },
  { value: 'rust',           label: 'Rust' },
  { value: 'go',             label: 'Go' },
  { value: 'react',          label: 'React' },
  { value: 'nextjs',         label: 'Next.js' },
  { value: 'node',           label: 'Node.js' },
  { value: 'system_design',  label: 'System Design' },
  { value: 'code_review',    label: 'Code Review' },
  { value: 'implementation', label: 'Implementation' },
  { value: 'testing',        label: 'Testing' },
  { value: 'debugging',      label: 'Debugging' },
  { value: 'security_audit', label: 'Security Audit' },
  { value: 'documentation',  label: 'Documentation' },
  { value: 'api_design',     label: 'API Design' },
  { value: 'database',       label: 'Database' },
  { value: 'devops',         label: 'DevOps' },
  { value: 'frontend',       label: 'Frontend' },
  { value: 'backend',        label: 'Backend' },
  { value: 'e2e',            label: 'E2E Testing' },
  { value: 'fast_iteration', label: 'Fast Iteration' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function bail(val: unknown): asserts val is string | string[] | boolean {
  if (p.isCancel(val)) { p.cancel('Cancelled.'); process.exit(0); }
}

async function detectOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.models || []).map((m: any) => m.name);
  } catch { return []; }
}

function shortName(provider: string): string {
  return provider === 'anthropic' ? 'claude'
    : provider === 'openai' ? 'gpt'
    : provider === 'google' ? 'gemini'
    : 'local';
}

// ── Agent directory structure ───────────────────────────────────────────────
export function createAgentDirectory(agentId: string, agentConfig: any): void {
  const agentDir = resolve(process.cwd(), '.gossip', 'agents', agentId);
  mkdirSync(resolve(agentDir, 'memory'), { recursive: true });
  mkdirSync(resolve(agentDir, 'context'), { recursive: true });
  mkdirSync(resolve(agentDir, 'skills'), { recursive: true });

  // instructions.md — agent system prompt / personality / rules
  const instructionsContent = generateInstructions(agentId, agentConfig);
  writeFileSync(resolve(agentDir, 'instructions.md'), instructionsContent);

  // memory/memory.md — structured memory (3-section format from crab-language)
  writeFileSync(resolve(agentDir, 'memory', 'memory.md'), `# Core Memories

<!-- Permanent knowledge: project rules, key decisions, important facts -->
<!-- These survive compaction and are always included in context -->

# Long-Term Memory

<!-- LLM-compacted summaries of past activity -->
<!-- Written as first-person bullets: "- I discovered that..." -->
<!-- Updated automatically when recent activity exceeds threshold -->

# Recent Activity

<!-- Cycle-by-cycle summaries of recent work -->
<!-- Oldest entries get compacted into Long-Term Memory -->
`);

  // memory/MEMORY.md — memory index linking to individual memory files
  writeFileSync(resolve(agentDir, 'memory', 'MEMORY.md'), `# ${agentId} Memory Index

Memory files for this agent. Each captures knowledge that persists across sessions.

## Structure
- \`memory.md\` — Main memory (Core + Long-Term + Recent Activity)
- Individual \`.md\` files below for specific topics

## Project Knowledge
<!-- e.g. - [Auth patterns](auth-patterns.md) -->

## Decisions
<!-- e.g. - [Chose JWT over sessions](decision-jwt.md) -->

## Patterns
<!-- e.g. - [Error handling convention](pattern-errors.md) -->
`);

  // context/README.md — project-specific context files
  writeFileSync(resolve(agentDir, 'context', 'README.md'), `# ${agentId} Context

Place files here that this agent should always have access to.
These are injected into the agent's prompt when it starts a task.

Examples:
- Architecture diagrams
- API specifications
- Coding conventions
- Domain-specific knowledge
`);

  // config.json — agent-specific overrides
  writeFileSync(resolve(agentDir, 'config.json'), JSON.stringify({
    id: agentId,
    provider: agentConfig.provider,
    model: agentConfig.model,
    preset: agentConfig.preset,
    skills: agentConfig.skills,
    temperature: 0.7,
    maxTokens: 4096,
    maxToolTurns: 10,
  }, null, 2));
}

function generateInstructions(agentId: string, config: any): string {
  const presetInstructions: Record<string, string> = {
    architect: `You are a software architect. Your role is to:
- Decompose complex problems into manageable components
- Evaluate design trade-offs and make informed decisions
- Review code for architectural integrity and consistency
- Produce clear specifications and design documents
- Consider scalability, security, and maintainability

When reviewing code, focus on component boundaries, dependency direction,
and whether the design will scale. Don't nitpick style — focus on structure.`,

    implementer: `You are a skilled developer. Your role is to:
- Write clean, tested, production-ready code
- Follow existing patterns and conventions in the codebase
- Write tests alongside implementation (TDD when appropriate)
- Keep implementations simple and focused — no over-engineering
- Handle error cases explicitly

Write code that a tired developer at 3am could understand and debug.
Prefer boring, proven approaches over clever tricks.`,

    reviewer: `You are a code reviewer. Your role is to:
- Find bugs, security vulnerabilities, and logic errors
- Check for missing error handling and edge cases
- Verify code follows project conventions and patterns
- Assess performance implications of changes
- Provide specific, actionable feedback with code examples

Be thorough but not pedantic. Focus on issues that would cause
real problems in production, not style preferences.`,

    tester: `You are a test engineer. Your role is to:
- Write comprehensive tests covering happy paths and edge cases
- Identify untested code paths and missing coverage
- Design test scenarios that catch real bugs
- Keep tests maintainable and fast
- Test behavior, not implementation details

A good test suite is one that catches bugs early and gives developers
confidence to refactor. Prefer integration tests over unit tests when
the boundary is unclear.`,

    researcher: `You are a technical researcher. Your role is to:
- Read and summarize documentation, APIs, and code
- Gather context needed for implementation decisions
- Find relevant examples and patterns in existing code
- Synthesize findings into clear, actionable summaries
- Identify risks and unknowns before implementation begins

Your output should save other agents time. Be specific about what
you found, where you found it, and what it means for the task.`,

    debugger: `You are a debugger. Your role is to:
- Investigate errors systematically — reproduce, isolate, identify root cause
- Form hypotheses and test them methodically
- Trace execution paths through the codebase
- Identify the minimal fix that addresses the root cause
- Write regression tests to prevent recurrence

Never guess at fixes. Understand the root cause before proposing a solution.
The cheapest bug is one that never comes back.`,
  };

  const roleInstructions = presetInstructions[config.preset] || `You are a ${config.preset} agent. Follow the project conventions and complete your assigned tasks thoroughly.`;

  return `# ${agentId} — Agent Instructions

## Identity
- **Agent ID:** ${agentId}
- **Provider:** ${config.provider}
- **Model:** ${config.model}
- **Role:** ${config.preset}
- **Skills:** ${config.skills.join(', ')}

## Role

${roleInstructions}

## Project Rules

- Read the project's CLAUDE.md (if it exists) before starting work
- Follow existing code patterns and conventions
- Keep files under 300 lines
- Use explicit error handling — never swallow errors silently
- Write tests for new functionality

## Memory

Your memory files are stored in \`./memory/\`. Use them to:
- Track decisions you've made and why
- Remember project-specific patterns you've learned
- Note things that surprised you about the codebase

## Context

Files in \`./context/\` are always available to you. Check them for:
- Architecture diagrams
- API specifications
- Domain-specific knowledge
`;
}

// ── Main command ────────────────────────────────────────────────────────────
export async function createAgent(): Promise<void> {
  p.intro('  Create New Agent');

  // ── Load existing config ────────────────────────────────────────────────
  const configPath = resolve(process.cwd(), 'gossip.agents.json');
  let config: any = { main_agent: {}, agents: {} };
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  }

  const existingAgents = Object.keys(config.agents || {});
  if (existingAgents.length > 0) {
    p.log.info(`Current team: ${existingAgents.join(', ')}`);
  }

  // ── Select provider ─────────────────────────────────────────────────────
  const ollamaModels = await detectOllamaModels();
  const providerOptions = PROVIDERS.filter(
    pr => pr.value !== 'local' || ollamaModels.length > 0
  ).map(pr => ({
    value: pr.value,
    label: pr.label,
    hint: pr.value === 'local' ? `${ollamaModels.length} models detected` : undefined,
  }));

  const provider = await p.select({
    message: 'Provider:',
    options: providerOptions,
  });
  bail(provider);

  // ── API key check ───────────────────────────────────────────────────────
  if (provider !== 'local') {
    const keychain = new Keychain();
    const existing = await keychain.getKey(provider as string);
    if (!existing) {
      const key = await p.password({
        message: `${PROVIDERS.find(pr => pr.value === provider)!.label} API key:`,
        validate: (v) => { if (!v?.trim()) return 'Required'; },
      });
      bail(key);
      await keychain.setKey(provider as string, key);
      p.log.success('Key saved to keychain');
    } else {
      p.log.success('API key already configured');
    }
  }

  // ── Select model ────────────────────────────────────────────────────────
  const modelOptions = provider === 'local'
    ? ollamaModels.map(m => ({ value: m, label: m }))
    : MODELS[provider as string] || [];

  const model = await p.select({
    message: 'Model:',
    options: modelOptions,
  });
  bail(model);

  // ── Select role ─────────────────────────────────────────────────────────
  const preset = await p.select({
    message: 'Role:',
    options: PRESETS,
  });
  bail(preset);

  // ── Select skills ───────────────────────────────────────────────────────
  let skills: string[];
  if (preset === 'custom') {
    const selectedSkills = await p.multiselect({
      message: 'Select skills:',
      options: AVAILABLE_SKILLS,
      required: true,
    });
    bail(selectedSkills);
    skills = selectedSkills as string[];
  } else {
    const defaultSkills = PRESET_SKILLS[preset as string] || [];
    p.log.info(`Default skills: ${defaultSkills.join(', ')}`);

    const customize = await p.confirm({
      message: 'Customize skills?',
      initialValue: false,
    });
    bail(customize);

    if (customize) {
      const selectedSkills = await p.multiselect({
        message: 'Select skills:',
        options: AVAILABLE_SKILLS.map(s => ({
          ...s,
          initialValue: defaultSkills.includes(s.value),
        })),
        required: true,
      });
      bail(selectedSkills);
      skills = selectedSkills as string[];
    } else {
      skills = defaultSkills;
    }
  }

  // ── Custom instructions ─────────────────────────────────────────────────
  const customInstructions = await p.text({
    message: 'Any custom instructions? (optional)',
    placeholder: 'e.g. "Always use functional patterns" or "Focus on performance"',
  });
  bail(customInstructions);

  // ── Generate agent ID ───────────────────────────────────────────────────
  const defaultId = `${shortName(provider as string)}-${preset}`;
  const agentId = await p.text({
    message: 'Agent ID:',
    defaultValue: defaultId,
    placeholder: defaultId,
    validate: (v) => {
      if (!v?.trim()) return 'Required';
      if (existingAgents.includes(v.trim())) return `Agent "${v.trim()}" already exists`;
      if (!/^[a-z0-9-]+$/.test(v.trim())) return 'Use lowercase letters, numbers, and hyphens only';
    },
  });
  bail(agentId);

  // ── Create agent config ─────────────────────────────────────────────────
  const agentConfig = {
    provider: provider as string,
    model: model as string,
    preset: preset as string,
    skills,
    ...(customInstructions ? { customInstructions: customInstructions as string } : {}),
  };

  // ── Create agent directory with files ───────────────────────────────────
  createAgentDirectory(agentId as string, agentConfig);

  // ── Update gossip.agents.json ───────────────────────────────────────────
  if (!config.agents) config.agents = {};
  config.agents[agentId as string] = agentConfig;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // ── Append custom instructions to agent's instructions.md ──────────────
  if (customInstructions && (customInstructions as string).trim()) {
    const instructionsPath = resolve(process.cwd(), '.gossip', 'agents', agentId as string, 'instructions.md');
    const existing = readFileSync(instructionsPath, 'utf-8');
    writeFileSync(instructionsPath, existing + `\n## Custom Instructions\n\n${customInstructions}\n`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const agentDir = resolve('.gossip', 'agents', agentId as string);
  p.note(
    `ID:       ${agentId}\n` +
    `Provider: ${provider}\n` +
    `Model:    ${model}\n` +
    `Role:     ${preset}\n` +
    `Skills:   ${skills.join(', ')}\n\n` +
    `Files created:\n` +
    `  ${agentDir}/instructions.md    — system prompt & rules\n` +
    `  ${agentDir}/memory/MEMORY.md   — persistent memory index\n` +
    `  ${agentDir}/context/           — context files for this agent\n` +
    `  ${agentDir}/config.json        — agent-specific overrides`,
    'Agent Created'
  );

  p.outro(`Run gossipcat to start chatting with your updated team.`);
}

// ── List agents command ─────────────────────────────────────────────────────
export async function listAgents(): Promise<void> {
  const configPath = resolve(process.cwd(), 'gossip.agents.json');
  if (!existsSync(configPath)) {
    console.log('No gossip.agents.json found. Run gossipcat setup first.');
    return;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const agents = config.agents || {};
  const agentIds = Object.keys(agents);

  if (agentIds.length === 0) {
    console.log('No agents configured. Run gossipcat create-agent to add one.');
    return;
  }

  p.intro('  Agent Team');

  for (const [id, agent] of Object.entries(agents) as [string, any][]) {
    const hasDir = existsSync(resolve(process.cwd(), '.gossip', 'agents', id));
    const memoryDir = resolve(process.cwd(), '.gossip', 'agents', id, 'memory');
    let memoryCount = 0;
    if (existsSync(memoryDir)) {
      const { readdirSync } = require('fs');
      memoryCount = readdirSync(memoryDir).filter((f: string) => f.endsWith('.md') && f !== 'MEMORY.md').length;
    }

    p.log.message(
      `  ${id}\n` +
      `  Provider: ${agent.provider}  Model: ${agent.model}\n` +
      `  Role: ${agent.preset}  Skills: ${agent.skills?.join(', ') || 'none'}\n` +
      `  Files: ${hasDir ? '.gossip/agents/' + id + '/' : 'no local files'}` +
      (memoryCount > 0 ? `  Memories: ${memoryCount}` : '')
    );
  }

  if (config.main_agent) {
    p.log.info(`Orchestrator: ${config.main_agent.model} (${config.main_agent.provider})`);
  }

  p.outro(`${agentIds.length} agent${agentIds.length > 1 ? 's' : ''} configured`);
}

// ── Remove agent command ────────────────────────────────────────────────────
export async function removeAgent(agentId?: string): Promise<void> {
  const configPath = resolve(process.cwd(), 'gossip.agents.json');
  if (!existsSync(configPath)) {
    console.log('No gossip.agents.json found.');
    return;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const agents = config.agents || {};
  const agentIds = Object.keys(agents);

  if (agentIds.length === 0) {
    console.log('No agents to remove.');
    return;
  }

  p.intro('  Remove Agent');

  if (!agentId) {
    const selected = await p.select({
      message: 'Which agent to remove?',
      options: agentIds.map(id => ({
        value: id,
        label: id,
        hint: `${agents[id].provider} / ${agents[id].model} / ${agents[id].preset}`,
      })),
    });
    bail(selected);
    agentId = selected as string;
  }

  if (!agents[agentId]) {
    p.log.error(`Agent "${agentId}" not found.`);
    return;
  }

  const keepFiles = await p.confirm({
    message: `Keep ${agentId}'s local files (.gossip/agents/${agentId}/)? They contain memories and instructions.`,
    initialValue: true,
  });
  bail(keepFiles);

  delete agents[agentId];
  config.agents = agents;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  if (!keepFiles) {
    const agentDir = resolve(process.cwd(), '.gossip', 'agents', agentId);
    if (existsSync(agentDir)) {
      const { rmSync } = require('fs');
      rmSync(agentDir, { recursive: true, force: true });
      p.log.info(`Deleted ${agentDir}`);
    }
  } else {
    p.log.info(`Local files preserved at .gossip/agents/${agentId}/`);
  }

  p.log.success(`Removed ${agentId} from team`);
  p.outro(`${Object.keys(agents).length} agents remaining`);
}
