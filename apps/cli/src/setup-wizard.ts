import * as p from '@clack/prompts';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { Keychain } from './keychain';

// ── Provider + Model catalog ────────────────────────────────────────────────
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    hint: 'claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5',
    models: [
      { value: 'claude-opus-4-6',   label: 'Claude Opus 4.6',   hint: 'Most capable, highest cost' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',  hint: 'Fast + smart — recommended' },
      { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',   hint: 'Fastest, lowest cost' },
    ],
  },
  openai: {
    label: 'OpenAI (GPT)',
    hint: 'gpt-5, gpt-4o, o3, o3-mini',
    models: [
      { value: 'gpt-5',      label: 'GPT-5',       hint: 'Most capable' },
      { value: 'gpt-4o',     label: 'GPT-4o',      hint: 'Fast + smart — recommended' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini', hint: 'Fastest, lowest cost' },
      { value: 'o3',         label: 'o3',           hint: 'Reasoning model' },
      { value: 'o3-mini',    label: 'o3-mini',      hint: 'Fast reasoning' },
    ],
  },
  google: {
    label: 'Google (Gemini)',
    hint: 'gemini-2.5-pro, gemini-2.5-flash',
    models: [
      { value: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro',   hint: 'Most capable' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'Fast — recommended' },
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', hint: 'Previous gen, stable' },
    ],
  },
} as const;

type ProviderKey = keyof typeof PROVIDERS | 'local';

const PRESETS = [
  { value: 'architect',   label: 'Architect',   hint: 'Design, decompose, review trade-offs' },
  { value: 'implementer', label: 'Implementer', hint: 'Write code, build features, tests alongside' },
  { value: 'reviewer',    label: 'Reviewer',    hint: 'Find bugs, security holes, quality issues' },
  { value: 'tester',      label: 'Tester',      hint: 'Write tests, verify, coverage analysis' },
  { value: 'researcher',  label: 'Researcher',  hint: 'Read docs, gather context, summarize' },
  { value: 'debugger',    label: 'Debugger',    hint: 'Investigate errors, trace root causes' },
] as const;

const PRESET_SKILLS: Record<string, string[]> = {
  architect:   ['typescript', 'system_design', 'code_review', 'api_design'],
  implementer: ['typescript', 'implementation', 'testing', 'react'],
  reviewer:    ['code_review', 'security_audit', 'debugging'],
  tester:      ['testing', 'debugging', 'e2e', 'integration'],
  researcher:  ['documentation', 'api_design', 'research'],
  debugger:    ['debugging', 'testing', 'code_review'],
};

// ── Helpers ─────────────────────────────────────────────────────────────────
async function detectOllama(): Promise<string[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.models || []).map((m: any) => m.name);
  } catch {
    return [];
  }
}

function shortName(provider: string): string {
  return provider === 'anthropic' ? 'claude'
    : provider === 'openai' ? 'gpt'
    : provider === 'google' ? 'gemini'
    : 'local';
}

// ── Main wizard ─────────────────────────────────────────────────────────────
export async function runSetupWizard(): Promise<void> {
  p.intro('  Gossip Mesh  —  Multi-Agent Orchestration Platform');

  // ── Detect local models ─────────────────────────────────────────────────
  const ollamaModels = await detectOllama();

  // ── Step 1: Select providers ────────────────────────────────────────────
  const providerOptions: Array<{ value: ProviderKey; label: string; hint?: string }> = [
    { value: 'anthropic', label: PROVIDERS.anthropic.label, hint: PROVIDERS.anthropic.hint },
    { value: 'openai',    label: PROVIDERS.openai.label,    hint: PROVIDERS.openai.hint },
    { value: 'google',    label: PROVIDERS.google.label,    hint: PROVIDERS.google.hint },
  ];

  if (ollamaModels.length > 0) {
    providerOptions.push({
      value: 'local',
      label: `Local (Ollama)`,
      hint: `${ollamaModels.length} model${ollamaModels.length > 1 ? 's' : ''} detected — ${ollamaModels.slice(0, 3).join(', ')}`,
    });
  }

  const selectedProviders = await p.multiselect({
    message: 'Which providers do you want to use?',
    options: providerOptions,
    required: true,
  });

  if (p.isCancel(selectedProviders)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // ── Step 2: API keys ────────────────────────────────────────────────────
  const keychain = new Keychain();
  const configuredProviders: ProviderKey[] = [];

  for (const provider of selectedProviders) {
    if (provider === 'local') {
      p.log.success('Ollama — no API key needed');
      configuredProviders.push('local');
      continue;
    }

    const info = PROVIDERS[provider as keyof typeof PROVIDERS];
    const key = await p.password({
      message: `${info.label} API key:`,
      validate: (val) => {
        if (!val || val.trim().length === 0) return 'API key is required. Deselect the provider to skip it.';
      },
    });

    if (p.isCancel(key)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    await keychain.setKey(provider, key);
    configuredProviders.push(provider);
    p.log.success(`${info.label} — key saved to keychain`);
  }

  if (configuredProviders.length === 0) {
    p.cancel('No providers configured. Run gossipcat setup to try again.');
    process.exit(0);
  }

  // ── Step 3: Orchestrator model ──────────────────────────────────────────
  p.log.step('Choose your orchestrator — the main agent that routes tasks to your team.');
  p.log.info('Tip: Pick a fast model here. It only routes, not heavy lifting.');

  const mainProvider = configuredProviders[0];
  const mainModelOptions = mainProvider === 'local'
    ? ollamaModels.slice(0, 10).map((m, i) => ({
        value: m, label: m, hint: i === 0 ? 'Recommended' : undefined,
      }))
    : PROVIDERS[mainProvider as keyof typeof PROVIDERS].models.map(m => ({
        value: m.value, label: m.label, hint: m.hint,
      }));

  const mainModel = await p.select({
    message: `Orchestrator model (${mainProvider}):`,
    options: mainModelOptions,
  });

  if (p.isCancel(mainModel)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // ── Step 4: Configure agent team ────────────────────────────────────────
  p.log.step('Now let\'s set up your agent team. Each provider gets an agent with a role.');

  const agents: Record<string, any> = {};

  for (const provider of configuredProviders) {
    const providerLabel = provider === 'local'
      ? 'Local (Ollama)'
      : PROVIDERS[provider as keyof typeof PROVIDERS].label;

    p.log.message(`\n  ${providerLabel}`);

    // Select role
    const preset = await p.select({
      message: `Role for ${providerLabel} agent:`,
      options: PRESETS.map(pr => ({ value: pr.value, label: pr.label, hint: pr.hint })),
    });

    if (p.isCancel(preset)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    // Select model
    const modelOptions = provider === 'local'
      ? ollamaModels.slice(0, 10).map((m, i) => ({
          value: m, label: m, hint: i === 0 ? 'Recommended' : undefined,
        }))
      : PROVIDERS[provider as keyof typeof PROVIDERS].models.map(m => ({
          value: m.value, label: m.label, hint: m.hint,
        }));

    const model = await p.select({
      message: `Model for ${providerLabel} agent:`,
      options: modelOptions,
    });

    if (p.isCancel(model)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    const agentId = `${shortName(provider)}-${preset}`;
    agents[agentId] = {
      provider,
      model,
      preset,
      skills: PRESET_SKILLS[preset as string] || [],
    };

    p.log.success(`${agentId} — ${model} as ${preset}`);
  }

  // ── Save config ─────────────────────────────────────────────────────────
  const config = {
    main_agent: { provider: mainProvider, model: mainModel },
    agents,
  };

  const configPath = resolve(process.cwd(), 'gossip.agents.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // ── Generate .mcp.json if not exists ────────────────────────────────────
  const mcpPath = resolve(process.cwd(), '.mcp.json');
  if (!existsSync(mcpPath)) {
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        gossipcat: {
          command: 'npx',
          args: ['gossipcat-mcp'],
          cwd: process.cwd(),
        },
      },
    }, null, 2));
    p.log.success('MCP server config saved to .mcp.json');
  }

  // ── Generate Claude Code rules for hybrid agent dispatch ────────────────
  const rulesDir = resolve(process.cwd(), '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });

  const agentList = Object.entries(agents)
    .map(([id, a]: [string, any]) => `- ${id}: ${a.provider}/${a.model} (${a.preset})`)
    .join('\n');

  writeFileSync(resolve(rulesDir, 'gossipcat.md'), `# Gossipcat — Multi-Agent Dispatch

This project uses gossipcat for multi-agent orchestration. You have two dispatch mechanisms:

## Non-Claude agents (Gemini, GPT, local models) — use gossipcat MCP tools:
\`\`\`
gossip_dispatch(agent_id: "<id>", task: "description")
gossip_dispatch_parallel(tasks: [{agent_id: "<id>", task: "..."}, ...])
gossip_collect(task_ids: ["..."])
gossip_agents()   — list available agents
\`\`\`

## Claude agents (Sonnet, Haiku) — use Claude Code's built-in Agent tool (free):
\`\`\`
Agent(model: "sonnet", prompt: "...", run_in_background: true)
Agent(model: "haiku", prompt: "...", run_in_background: true)
\`\`\`

## Parallel multi-provider dispatch — combine both in one message:
Send gossip_dispatch for non-Claude agents AND Agent tool for Claude agents simultaneously.
Then synthesize all results.

## Available agents
${agentList}

## Skills
Skills auto-inject from agent config. No need to pass them manually.

## Adding agents
Edit gossip.agents.json — new agents hot-reload on next dispatch.
`);

  p.log.success('Claude Code rules saved to .claude/rules/gossipcat.md');

  // ── Summary ─────────────────────────────────────────────────────────────
  const agentCount = Object.keys(agents).length;
  const summary = Object.entries(agents)
    .map(([id, a]: [string, any]) => `  ${id} → ${a.model} (${a.preset})`)
    .join('\n');

  p.note(
    `Orchestrator: ${mainModel} (${mainProvider})\n\nTeam (${agentCount} agent${agentCount > 1 ? 's' : ''}):\n${summary}`,
    'Your Setup'
  );

  p.outro('Ready! Run gossipcat to start chatting.');
}
