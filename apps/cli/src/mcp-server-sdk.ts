#!/usr/bin/env node
/**
 * Gossipcat MCP Server — thin adapter over MainAgent/DispatchPipeline
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// ── Environment detection ────────────────────────────────────────────────

type HostEnvironment = 'claude-code' | 'cursor' | 'vscode' | 'windsurf' | 'unknown';

interface EnvironmentInfo {
  host: HostEnvironment;
  supportsNativeAgents: boolean;
  nativeAgentDir: string | null;
  rulesDir: string;       // where to write instruction rules
  rulesFile: string;      // the file the host reads at session start
}

function detectEnvironment(): EnvironmentInfo {
  // Claude Code sets CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return { host: 'claude-code', supportsNativeAgents: true, nativeAgentDir: '.claude/agents', rulesDir: '.claude/rules', rulesFile: '.claude/rules/gossipcat.md' };
  }
  // Cursor uses .cursor/rules/ or .cursorrules
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION_ID || process.env.CURSOR) {
    return { host: 'cursor', supportsNativeAgents: false, nativeAgentDir: null, rulesDir: '.cursor/rules', rulesFile: '.cursor/rules/gossipcat.mdc' };
  }
  // Windsurf uses .windsurfrules
  if (process.env.WINDSURF || process.env.WINDSURF_SESSION_ID) {
    return { host: 'windsurf', supportsNativeAgents: false, nativeAgentDir: null, rulesDir: '.', rulesFile: '.windsurfrules' };
  }
  // VS Code MCP extension
  if (process.env.VSCODE_PID || process.env.TERM_PROGRAM === 'vscode') {
    return { host: 'vscode', supportsNativeAgents: false, nativeAgentDir: null, rulesDir: '.github', rulesFile: '.github/copilot-instructions.md' };
  }
  // Fallback: write CLAUDE.md (most common MCP host)
  return { host: 'unknown', supportsNativeAgents: false, nativeAgentDir: null, rulesDir: '.', rulesFile: 'GOSSIPCAT.md' };
}

const env = detectEnvironment();

// Native agent task tracking — results fed back via gossip_relay_result
const nativeTaskMap: Map<string, { agentId: string; task: string; startedAt: number }> = new Map();
const nativeAgentConfigs: Map<string, { model: string; instructions: string; description: string }> = new Map();
// Collected native results — so gossip_collect can return them alongside relay results
const nativeResultMap: Map<string, {
  id: string; agentId: string; task: string;
  status: 'completed' | 'failed';
  result?: string; error?: string;
  startedAt: number; completedAt: number;
}> = new Map();

// Lazy state — populated during boot()
let booted = false;
let bootPromise: Promise<void> | null = null;
let relay: any = null;
let toolServer: any = null;
let workers: Map<string, any> = new Map();
let mainAgent: any = null;
let keychain: any = null;

// Cache modules after first import
let _modules: any = null;

async function getModules() {
  if (_modules) return _modules;
  _modules = {
    RelayServer: (await import('@gossip/relay')).RelayServer,
    ToolServer: (await import('@gossip/tools')).ToolServer,
    ALL_TOOLS: (await import('@gossip/tools')).ALL_TOOLS,
    MainAgent: (await import('@gossip/orchestrator')).MainAgent,
    WorkerAgent: (await import('@gossip/orchestrator')).WorkerAgent,
    createProvider: (await import('@gossip/orchestrator')).createProvider,
    ...(await import('./config')),
    Keychain: (await import('./keychain')).Keychain,
  };
  return _modules;
}

async function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = doBoot().catch((err) => {
    bootPromise = null; // Reset so next call retries instead of permanently failing
    throw err;
  });
  return bootPromise;
}

async function doBoot() {
  const m = await getModules();

  const configPath = m.findConfigPath();
  if (!configPath) throw new Error('No gossip.agents.json found. Run gossipcat setup first.');

  const config = m.loadConfig(configPath);
  const agentConfigs = m.configToAgentConfigs(config);
  keychain = new m.Keychain();

  relay = new m.RelayServer({ port: 0 });
  await relay.start();

  toolServer = new m.ToolServer({ relayUrl: relay.url, projectRoot: process.cwd() });
  await toolServer.start();

  // Create workers before MainAgent to avoid duplicate relay connections.
  // Native agents skip worker creation — they're dispatched via Claude Code's Agent tool.
  for (const ac of agentConfigs) {
    if (ac.native) {
      // Load instructions for native agent dispatch
      const { existsSync: ex, readFileSync: rf } = require('fs');
      const { join: j } = require('path');
      const claudeAgentPath = j(process.cwd(), '.claude', 'agents', `${ac.id}.md`);
      const instrPath = j(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
      let instructions = '';
      if (ex(claudeAgentPath)) {
        instructions = rf(claudeAgentPath, 'utf-8').replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
      } else if (ex(instrPath)) {
        instructions = rf(instrPath, 'utf-8');
      }
      const modelTier = ac.model.includes('opus') ? 'opus' : ac.model.includes('haiku') ? 'haiku' : 'sonnet';
      nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.preset || '' });
      process.stderr.write(`[gossipcat] ${ac.id}: native agent (${modelTier}, dispatched via Agent tool)\n`);
      continue;
    }
    const key = await keychain.getKey(ac.provider);
    const llm = m.createProvider(ac.provider, ac.model, key ?? undefined);
    const { existsSync, readFileSync } = require('fs');
    const { join } = require('path');
    const instructionsPath = join(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
    const instructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf-8') : undefined;
    const worker = new m.WorkerAgent(ac.id, llm, relay.url, m.ALL_TOOLS, instructions);
    await worker.start();
    workers.set(ac.id, worker);
  }

  // Register Claude Code subagents from .claude/agents/*.md (native = no relay worker needed)
  const { loadClaudeSubagents, claudeSubagentsToConfigs } = await import('./config');
  const existingIds = new Set(agentConfigs.map((a: any) => a.id));
  const claudeSubagents = loadClaudeSubagents(process.cwd(), existingIds);
  if (claudeSubagents.length > 0) {
    const claudeConfigs = claudeSubagentsToConfigs(claudeSubagents);
    for (let i = 0; i < claudeSubagents.length; i++) {
      const sa = claudeSubagents[i];
      const ac = claudeConfigs[i];
      agentConfigs.push(ac);
      // Map model tier for Agent tool dispatch
      const modelTier = sa.model.includes('opus') ? 'opus' : sa.model.includes('haiku') ? 'haiku' : 'sonnet';
      nativeAgentConfigs.set(ac.id, { model: modelTier, instructions: sa.instructions, description: sa.description });
      process.stderr.write(`[gossipcat] Registered native agent: ${sa.id} (${modelTier}) — dispatched via Agent tool\n`);
    }
  }

  // Try main agent key first, fall back to any available provider key
  let mainProvider = config.main_agent.provider;
  let mainModel = config.main_agent.model;
  let mainKey = await keychain.getKey(config.main_agent.provider);
  if (!mainKey) {
    for (const ac of agentConfigs) {
      const key = await keychain.getKey(ac.provider);
      if (key) {
        mainProvider = ac.provider;
        mainModel = ac.model;
        mainKey = key;
        process.stderr.write(`[gossipcat] Main agent key unavailable, using ${ac.provider}/${ac.model} for orchestration\n`);
        break;
      }
    }
  }
  const supaKey = await keychain.getKey('supabase');
  const supaTeamSalt = await keychain.getKey('supabase-team-salt');
  mainAgent = new m.MainAgent({
    provider: mainProvider,
    model: mainModel,
    apiKey: mainKey ?? undefined,
    relayUrl: relay.url,
    agents: agentConfigs,
    projectRoot: process.cwd(),
    bootstrapPrompt: (() => {
      try {
        const { existsSync: e, readFileSync: r } = require('fs');
        const { join: j } = require('path');
        const bp = j(process.cwd(), '.gossip', 'bootstrap.md');
        return e(bp) ? r(bp, 'utf-8') : '';
      } catch { return ''; }
    })(),
    keyProvider: async (provider: string) => keychain.getKey(provider),
    toolServer: toolServer ? {
      assignScope: (agentId: string, scope: string) => toolServer.assignScope(agentId, scope),
      assignRoot: (agentId: string, root: string) => toolServer.assignRoot(agentId, root),
      releaseAgent: (agentId: string) => toolServer.releaseAgent(agentId),
    } : null,
    syncFactory: () => {
      try {
        const { existsSync: exists, readFileSync: readF } = require('fs');
        const { join: joinP } = require('path');
        const configPath = joinP(process.cwd(), '.gossip', 'supabase.json');
        if (!exists(configPath) || !supaKey) return null;
        const supaConfig = JSON.parse(readF(configPath, 'utf-8'));
        const { getUserId, getProjectId, getTeamUserId, getGitEmail } = require('./identity');
        const { TaskGraph: TG, TaskGraphSync: TGS } = require('@gossip/orchestrator');

        let userId: string;
        let displayName: string | null = null;
        if (supaConfig.mode === 'team') {
          const email = getGitEmail();
          if (!supaTeamSalt || !email) {
            process.stderr.write(`[gossipcat] Team sync disabled: ${!supaTeamSalt ? 'missing teamSalt in keychain' : 'no git email configured'}. Run: gossipcat sync --setup\n`);
            return null;
          }
          userId = getTeamUserId(email, supaTeamSalt);
          displayName = supaConfig.displayName || email;
        } else {
          userId = getUserId(process.cwd());
        }

        return new TGS(new TG(process.cwd()), supaConfig.url, supaKey, userId, getProjectId(process.cwd()), process.cwd(), displayName);
      } catch { return null; }
    },
  });
  // Pass existing workers so MainAgent doesn't create duplicates
  mainAgent.setWorkers(workers);
  await mainAgent.start();

  // Wire adaptive team intelligence (overlap detection + lens generation)
  try {
    const { OverlapDetector, LensGenerator } = await import('@gossip/orchestrator');
    
    // Default to the main agent's model
    let utilityLlm = m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined);
    let utilityModelId = `${mainProvider}/${mainModel}`;

    if (config.utility_model) {
      const utilityKey = await keychain.getKey(config.utility_model.provider);
      if (utilityKey) {
        // If a utility model is configured AND its key exists, override the default
        utilityLlm = m.createProvider(config.utility_model.provider, config.utility_model.model, utilityKey);
        utilityModelId = `${config.utility_model.provider}/${config.utility_model.model}`;
      } else {
        // If configured but key is missing, just warn. The fallback is already set.
        process.stderr.write(`[gossipcat] Utility model key for "${config.utility_model.provider}" not found, falling back to main agent model for lens generation.\n`);
      }
    }
    
    mainAgent.setOverlapDetector(new OverlapDetector());
    mainAgent.setLensGenerator(new LensGenerator(utilityLlm));
    process.stderr.write(`[gossipcat] Adaptive team intelligence ready (utility: ${utilityModelId})\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Adaptive team intelligence failed: ${(err as Error).message}\n`);
  }

  // Create gossip publisher and wire into pipeline
  try {
    const { GossipAgent: GossipAgentPub } = await import('@gossip/client');
    const publisherAgent = new GossipAgentPub({
      agentId: 'gossip-publisher',
      relayUrl: relay.url,
      reconnect: true,
    });
    await publisherAgent.connect();

    const { GossipPublisher: GossipPub } = await import('@gossip/orchestrator');
    const gossipPublisher = new GossipPub(
      m.createProvider(config.main_agent.provider, config.main_agent.model, mainKey ?? undefined),
      { publishToChannel: (channel: string, data: unknown) => publisherAgent.sendChannel(channel, data as Record<string, unknown>) }
    );
    mainAgent.setGossipPublisher(gossipPublisher);
    process.stderr.write(`[gossipcat] Gossip publisher ready\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Gossip publisher failed: ${(err as Error).message}\n`);
  }

  booted = true;
  process.stderr.write(`[gossipcat] Booted: relay :${relay.port}, ${workers.size} workers\n`);
}

/**
 * Hot-reload: re-read gossip.agents.json and spawn any new workers.
 * Serialized — concurrent calls wait for the first to finish.
 */
let syncPromise: Promise<void> | null = null;
async function syncWorkersViaKeychain() {
  if (!booted) return;
  if (syncPromise) return syncPromise;
  syncPromise = doSyncWorkers().finally(() => { syncPromise = null; });
  return syncPromise;
}
async function doSyncWorkers() {
  try {
    const m = await getModules();
    const { loadClaudeSubagents, claudeSubagentsToConfigs } = await import('./config');

    const configPath = m.findConfigPath();
    if (!configPath) return;

    const config = m.loadConfig(configPath);
    const agentConfigs = m.configToAgentConfigs(config);

    // Register any new agent configs (including native flag)
    for (const ac of agentConfigs) {
      mainAgent.registerAgent(ac);
      // [H2 fix] Populate nativeAgentConfigs for config-defined native agents
      if (ac.native && !nativeAgentConfigs.has(ac.id)) {
        const { existsSync: ex, readFileSync: rf } = require('fs');
        const { join: j } = require('path');
        const claudeAgentPath = j(process.cwd(), '.claude', 'agents', `${ac.id}.md`);
        const instrPath = j(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
        let instructions = '';
        if (ex(claudeAgentPath)) {
          instructions = rf(claudeAgentPath, 'utf-8').replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
        } else if (ex(instrPath)) {
          instructions = rf(instrPath, 'utf-8');
        }
        const modelTier = ac.model.includes('opus') ? 'opus' : ac.model.includes('haiku') ? 'haiku' : 'sonnet';
        nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.preset || '' });
      }
    }

    // Also register Claude Code subagents discovered from .claude/agents/
    const existingIds = new Set([...agentConfigs.map((a: any) => a.id), ...workers.keys(), ...nativeAgentConfigs.keys()]);
    const claudeSubagents = loadClaudeSubagents(process.cwd(), existingIds);
    if (claudeSubagents.length > 0) {
      const claudeConfigs = claudeSubagentsToConfigs(claudeSubagents);
      for (let i = 0; i < claudeSubagents.length; i++) {
        const sa = claudeSubagents[i];
        const ac = claudeConfigs[i];
        mainAgent.registerAgent(ac);
        // [H2 fix] Populate nativeAgentConfigs for hot-reloaded subagents
        const modelTier = sa.model.includes('opus') ? 'opus' : sa.model.includes('haiku') ? 'haiku' : 'sonnet';
        nativeAgentConfigs.set(ac.id, { model: modelTier, instructions: sa.instructions, description: sa.description });
      }
    }

    // Sync only non-native workers (native agents use Agent tool, not relay)
    const added = await mainAgent.syncWorkers((provider: string) => keychain.getKey(provider));
    if (added > 0) {
      const allConfigs = [...agentConfigs, ...claudeSubagentsToConfigs(claudeSubagents)];
      for (const ac of allConfigs) {
        if (!ac.native && !workers.has(ac.id)) {
          const w = mainAgent.getWorker(ac.id);
          if (w) workers.set(ac.id, w);
        }
      }
      process.stderr.write(`[gossipcat] Synced: ${workers.size} relay workers + ${nativeAgentConfigs.size} native agents\n`);
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] syncWorkers failed: ${(err as Error).message}\n`);
  }
}

// ── Create MCP Server ─────────────────────────────────────────────────────
const server = new McpServer({
  name: 'gossipcat',
  version: '0.1.0',
});

// ── High-level tool ───────────────────────────────────────────────────────
server.tool(
  'gossip_orchestrate',
  'Submit a task to the Gossip Mesh orchestrator for multi-agent execution',
  { task: z.string().describe('The task to execute') },
  async ({ task }) => {
    await boot();
    try {
      const response = await mainAgent.handleMessage(task, { mode: 'decompose' });
      const suffix = response.agents?.length ? `\n\n[Agents: ${response.agents.join(', ')}]` : '';
      return { content: [{ type: 'text' as const, text: response.text + suffix }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] };
    }
  }
);

// ── Plan: decompose with write-mode classification ────────────────────────
server.tool(
  'gossip_plan',
  'Plan a task with write-mode suggestions. Decomposes into sub-tasks, assigns agents, and classifies each as read or write with suggested write mode. Returns dispatch-ready JSON for approval before execution. Use this before gossip_dispatch_parallel for implementation tasks.',
  {
    task: z.string().describe('Task description (e.g. "fix the scope validation bug in packages/tools/")'),
    strategy: z.enum(['parallel', 'sequential', 'single']).optional()
      .describe('Override decomposition strategy. Omit to let the orchestrator decide.'),
  },
  async ({ task, strategy }) => {
    await boot();
    await syncWorkersViaKeychain();

    try {
      const { TaskDispatcher, AgentRegistry } = await import('@gossip/orchestrator');

      const { findConfigPath, loadConfig, configToAgentConfigs } = await import('./config');
      const configPath = findConfigPath();
      if (!configPath) return { content: [{ type: 'text' as const, text: 'No config found. Run gossip_setup first.' }] };

      const config = loadConfig(configPath);
      const agentConfigs = configToAgentConfigs(config);
      const registry = new AgentRegistry();
      for (const ac of agentConfigs) registry.register(ac);

      const { createProvider } = await import('@gossip/orchestrator');

      // Try main agent first, fall back to any agent with a working key
      let llm: any;
      const mainKey = await keychain.getKey(config.main_agent.provider);
      if (mainKey) {
        llm = createProvider(config.main_agent.provider, config.main_agent.model, mainKey);
      } else {
        // Fallback: use the first agent that has a working key
        for (const ac of agentConfigs) {
          const key = await keychain.getKey(ac.provider);
          if (key) {
            llm = createProvider(ac.provider, ac.model, key);
            process.stderr.write(`[gossipcat] gossip_plan: main agent key unavailable, using ${ac.provider}/${ac.model} for planning\n`);
            break;
          }
        }
        if (!llm) return { content: [{ type: 'text' as const, text: 'No API keys available. Run gossipcat setup to configure keys.' }] };
      }

      const dispatcher = new TaskDispatcher(llm, registry);

      // 1. Decompose
      const plan = await dispatcher.decompose(task);
      if (strategy) plan.strategy = strategy;

      // 2. Assign agents
      dispatcher.assignAgents(plan);

      // 3. Classify write modes
      const planned = await dispatcher.classifyWriteModes(plan);

      // 4. Build response
      const taskLines = planned.map((t: any, i: number) => {
        const tag = t.access === 'write' ? '[WRITE]' : '[READ]';
        let line = `  ${i + 1}. ${tag} ${t.agentId || 'unassigned'} → "${t.task}"`;
        if (t.writeMode) {
          line += `\n     write_mode: ${t.writeMode}`;
          if (t.scope) line += ` | scope: ${t.scope}`;
        }
        return line;
      }).join('\n');

      const assignedTasks = planned.filter((t: any) => t.agentId);
      const unassignedTasks = planned.filter((t: any) => !t.agentId);

      // Store plan state for chain threading
      const planId = randomUUID().slice(0, 8);
      const planState = {
        id: planId,
        task,
        strategy: plan.strategy,
        steps: assignedTasks.map((t: any, i: number) => ({
          step: i + 1,
          agentId: t.agentId,
          task: t.task,
          writeMode: t.writeMode,
          scope: t.scope,
        })),
        createdAt: Date.now(),
      };
      mainAgent.registerPlan(planState);

      const planJson = {
        strategy: plan.strategy,
        tasks: assignedTasks.map((t: any, i: number) => {
          const entry: Record<string, any> = { agent_id: t.agentId, task: t.task };
          if (t.writeMode) entry.write_mode = t.writeMode;
          if (t.scope) entry.scope = t.scope;
          entry.plan_id = planId;
          entry.step = i + 1;
          return entry;
        }),
      };

      let warnings = '';
      if (plan.warnings?.length) {
        warnings = `\nWarnings:\n${plan.warnings.map((w: string) => `  - ${w}`).join('\n')}\n`;
      }
      if (unassignedTasks.length) {
        warnings += `\nUnassigned (excluded from PLAN_JSON — no matching agent):\n${unassignedTasks.map((t: any) => `  - "${t.task}"`).join('\n')}\n`;
      }

      // Format dispatch instructions based on strategy
      let dispatchBlock: string;
      if (plan.strategy === 'sequential' || plan.strategy === 'single') {
        // Sequential: output individual gossip_dispatch calls
        const steps = planJson.tasks.map((t: Record<string, any>, i: number) => {
          const args = [`agent_id: "${t.agent_id}"`, `task: "${t.task}"`];
          if (t.write_mode) args.push(`write_mode: "${t.write_mode}"`);
          if (t.scope) args.push(`scope: "${t.scope}"`);
          args.push(`plan_id: "${planId}"`, `step: ${i + 1}`);
          return `Step ${i + 1}: gossip_dispatch(${args.join(', ')})\n         then: gossip_collect()`;
        });
        dispatchBlock = `Execute sequentially:\n${steps.join('\n\n')}`;
      } else {
        // Parallel: output gossip_dispatch_parallel payload
        dispatchBlock = `PLAN_JSON (pass to gossip_dispatch_parallel):\n${JSON.stringify(planJson)}`;
      }

      const text = `Plan: "${task}"\nPlan ID: ${planId}\n\nStrategy: ${plan.strategy}\n\nTasks:\n${taskLines}\n${warnings}\n---\n${dispatchBlock}`;

      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Plan error: ${err.message}` }] };
    }
  }
);

// ── Low-level: dispatch to specific agent ─────────────────────────────────
server.tool(
  'gossip_dispatch',
  'Send a task to a specific agent. Returns task ID for collecting results. For implementation tasks that modify files, use gossip_plan first to get a write-mode-aware dispatch plan, or pass write_mode explicitly. Without write_mode, agents can only read files. Skills are auto-injected — pass file paths in the task, not contents.',
  {
    agent_id: z.string().describe('Agent ID (e.g. "gemini-reviewer")'),
    task: z.string().describe('Task description. Reference file paths — the agent will read them via Tool Server.'),
    write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional().describe('Write mode: "sequential" (queued), "scoped" (directory-locked), "worktree" (git worktree isolation)'),
    scope: z.string().optional().describe('Directory scope for "scoped" write mode (e.g. "packages/relay/")'),
    timeout_ms: z.number().optional().describe('Write task timeout in ms. Default 300000.'),
    plan_id: z.string().optional().describe('Plan ID from gossip_plan. Enables chain context from prior steps.'),
    step: z.number().optional().describe('Step number in the plan (1-indexed).'),
  },
  async ({ agent_id, task, write_mode, scope, timeout_ms, plan_id, step }) => {
    await boot();
    await syncWorkersViaKeychain();

    if (!/^[a-zA-Z0-9_-]+$/.test(agent_id)) {
      return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${agent_id}"` }] };
    }

    const options: Record<string, unknown> = {};
    if (write_mode) {
      options.writeMode = write_mode as 'sequential' | 'scoped' | 'worktree';
      if (scope) options.scope = scope;
      if (timeout_ms) options.timeoutMs = timeout_ms;
    }
    if (plan_id) {
      if (!step) {
        return { content: [{ type: 'text' as const, text: 'plan_id requires step (1-indexed step number in the plan).' }] };
      }
      options.planId = plan_id;
      options.step = step;
    }
    const dispatchOptions = Object.keys(options).length > 0 ? options : undefined;

    // Native agent bridge: return Agent tool instructions instead of relay dispatch
    const nativeConfig = nativeAgentConfigs.get(agent_id);
    if (nativeConfig) {
      const taskId = randomUUID().slice(0, 8);
      nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now() });

      const agentPrompt = nativeConfig.instructions
        ? `${nativeConfig.instructions}\n\n---\n\nTask: ${task}`
        : task;

      // Only use worktree if explicitly requested AND project is a git repo
      let useWorktree = write_mode === 'worktree';
      if (useWorktree) {
        try {
          const { execSync } = require('child_process');
          execSync('git rev-parse --git-dir', { cwd: process.cwd(), stdio: 'ignore' });
        } catch {
          useWorktree = false; // not a git repo, skip worktree
        }
      }

      return { content: [{ type: 'text' as const, text:
        `NATIVE_DISPATCH: Execute this via Claude Code Agent tool, then relay the result.\n\n` +
        `Task ID: ${taskId}\n` +
        `Agent: ${agent_id}\n` +
        `Model: ${nativeConfig.model}\n\n` +
        `Step 1 — Run:\n` +
        `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}${useWorktree ? ', isolation: "worktree"' : ''}, run_in_background: true)\n\n` +
        `Step 2 — REQUIRED after agent completes:\n` +
        `gossip_relay_result(task_id: "${taskId}", result: "<agent output>")\n\n` +
        `⚠️ You MUST call gossip_relay_result for every native dispatch. Without it, the result is lost — no memory, no gossip, no consensus. Never skip this step.`
      }] };
    }

    try {
      const { taskId } = mainAgent.dispatch(agent_id, task, dispatchOptions as any);
      const modeLabel = write_mode ? ` [${write_mode}${scope ? `:${scope}` : ''}]` : '';
      return { content: [{ type: 'text' as const, text: `Dispatched to ${agent_id}${modeLabel}. Task ID: ${taskId}` }] };
    } catch (err: any) {
      process.stderr.write(`[gossipcat] dispatch failed: ${err.message}\n`);
      return { content: [{ type: 'text' as const, text: err.message }] };
    }
  }
);

// ── Low-level: parallel dispatch ──────────────────────────────────────────
server.tool(
  'gossip_dispatch_parallel',
  'Fan out tasks to multiple agents simultaneously. Use consensus: true to enable cross-review when collecting. For tasks involving file modifications, use gossip_plan first to get a pre-built task array with write modes, then pass it here.',
  {
    tasks: z.array(z.object({
      agent_id: z.string(),
      task: z.string(),
      write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional(),
      scope: z.string().optional(),
    })).describe('Array of { agent_id, task, write_mode?, scope? }'),
    consensus: z.boolean().default(false).describe('Enable consensus summary format in agent output. Pass consensus: true to gossip_collect later.'),
  },
  async ({ tasks: taskDefs, consensus }) => {
    await boot();
    await syncWorkersViaKeychain();

    // Validate all agent IDs before dispatching
    for (const def of taskDefs) {
      if (!/^[a-zA-Z0-9_-]+$/.test(def.agent_id)) {
        return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${def.agent_id}"` }] };
      }
    }

    // [C2 fix] Split native vs custom tasks — native agents have no relay worker
    const nativeTasks: Array<{ agent_id: string; task: string; write_mode?: string }> = [];
    const relayTasks: Array<{ agent_id: string; task: string; write_mode?: string; scope?: string }> = [];
    for (const def of taskDefs) {
      if (nativeAgentConfigs.has(def.agent_id)) {
        nativeTasks.push(def);
      } else {
        relayTasks.push(def);
      }
    }

    const lines: string[] = [];

    // Dispatch relay tasks normally
    if (relayTasks.length > 0) {
      const { taskIds, errors } = await mainAgent.dispatchParallel(
        relayTasks.map((d: any) => ({
          agentId: d.agent_id,
          task: d.task,
          options: d.write_mode ? { writeMode: d.write_mode, scope: d.scope } : undefined,
        })),
        consensus ? { consensus: true } : undefined,
      );
      for (const tid of taskIds) {
        const t = mainAgent.getTask(tid);
        lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
      }
      if (errors.length) lines.push(`Relay errors: ${errors.join(', ')}`);
    }

    // Create native dispatch instructions for Claude Code Agent tool
    const nativeInstructions: string[] = [];
    for (const def of nativeTasks) {
      const nativeConfig = nativeAgentConfigs.get(def.agent_id)!;
      const taskId = randomUUID().slice(0, 8);
      nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now() });

      const agentPrompt = nativeConfig.instructions
        ? `${nativeConfig.instructions}\n\n---\n\nTask: ${def.task}`
        : def.task;

      lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
      nativeInstructions.push(
        `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}${def.write_mode === 'worktree' ? ', isolation: "worktree"' : ''}, run_in_background: true)` +
        `\n  → then: gossip_relay_result(task_id: "${taskId}", result: "<output>")`
      );
    }

    let msg = `Dispatched ${taskDefs.length} tasks:\n${lines.join('\n')}`;
    if (consensus) msg += '\n\n📋 Consensus mode enabled.';
    if (nativeInstructions.length > 0) {
      msg += `\n\nNATIVE_DISPATCH: Execute these ${nativeInstructions.length} Agent calls in parallel, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
      msg += `\n\n⚠️ You MUST call gossip_relay_result for EVERY native agent after it completes. Without it, results are lost — no memory, no gossip, no consensus.`;
    }
    return { content: [{ type: 'text' as const, text: msg }] };
  }
);

// ── Low-level: collect results ────────────────────────────────────────────
server.tool(
  'gossip_collect',
  'Collect results from dispatched tasks. Waits for completion by default. Use consensus: true for cross-review round.',
  {
    task_ids: z.array(z.string()).default([]).describe('Task IDs to collect. Empty array for all.'),
    timeout_ms: z.number().default(120000).describe('Max wait time in ms.'),
    consensus: z.boolean().default(false).describe('Enable cross-review consensus. Agents review each others findings.'),
  },
  async ({ task_ids, timeout_ms, consensus }) => {
    await boot();

    // Collect relay tasks
    let collected;
    const requestedIds = task_ids.length > 0 ? task_ids : undefined;
    // Split requested IDs into relay vs native
    const relayIds = requestedIds?.filter(id => !nativeResultMap.has(id) && !nativeTaskMap.has(id));
    const nativeIds = requestedIds?.filter(id => nativeResultMap.has(id) || nativeTaskMap.has(id));

    try {
      const idsForRelay = relayIds && relayIds.length > 0 ? relayIds : (!requestedIds ? undefined : []);
      if (!idsForRelay || idsForRelay.length > 0) {
        collected = await mainAgent.collect(idsForRelay, timeout_ms, consensus ? { consensus: true } : undefined);
      } else {
        collected = { results: [], consensus: undefined };
      }
    } catch (err) {
      process.stderr.write(`[gossipcat] collect failed: ${(err as Error).message}\n`);
      collected = { results: [], consensus: undefined };
    }

    const { results: taskResults, consensus: consensusReport } = collected;

    // Include native results
    const allResults = [...taskResults];
    if (nativeIds && nativeIds.length > 0) {
      for (const id of nativeIds) {
        const nr = nativeResultMap.get(id);
        if (nr) {
          allResults.push(nr);
          nativeResultMap.delete(id); // consumed
        } else if (nativeTaskMap.has(id)) {
          allResults.push({ id, agentId: nativeTaskMap.get(id)!.agentId, task: nativeTaskMap.get(id)!.task, status: 'running' });
        }
      }
    } else if (!requestedIds) {
      // No specific IDs — include all collected native results
      for (const [id, nr] of nativeResultMap) {
        allResults.push(nr);
        nativeResultMap.delete(id);
      }
      // Include pending native tasks
      for (const [id, info] of nativeTaskMap) {
        allResults.push({ id, agentId: info.agentId, task: info.task, status: 'running' as const });
      }
    }

    if (allResults.length === 0) {
      return { content: [{ type: 'text' as const, text: requestedIds ? 'No matching tasks.' : 'No pending tasks.' }] };
    }

    const resultTexts = allResults.map((t: any) => {
      const dur = t.completedAt && t.startedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
      const modeTag = t.writeMode ? ` [${t.writeMode}${t.scope ? `:${t.scope}` : ''}]` : '';
      const nativeTag = nativeAgentConfigs.has(t.agentId) ? ' (native)' : '';
      let text: string;
      if (t.status === 'completed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}):\n${t.result}`;
      else if (t.status === 'failed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}): ERROR: ${t.error}`;
      else text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag}: still running...`;

      if (t.worktreeInfo) {
        text += `\n📁 Worktree: ${t.worktreeInfo.path} (branch: ${t.worktreeInfo.branch})`;
      }
      if (t.skillWarnings?.length) {
        text += `\n\n⚠️ Skill coverage gaps:\n${t.skillWarnings.map((w: string) => `  - ${w}`).join('\n')}`;
      }
      return text;
    });

    let output = resultTexts.join('\n\n---\n\n');

    if (consensusReport) {
      output += '\n\n' + consensusReport.summary;
    }

    return { content: [{ type: 'text' as const, text: output }] };
  }
);

// ── Consensus: dispatch with summary instruction ─────────────────────────
server.tool(
  'gossip_dispatch_consensus',
  'Dispatch tasks to multiple agents with consensus summary instruction injected. Agents will include a ## Consensus Summary section in their output. Returns task IDs — call gossip_collect_consensus to collect results with cross-review.',
  {
    tasks: z.array(z.object({
      agent_id: z.string(),
      task: z.string(),
    })).describe('Array of { agent_id, task } — all agents review the same or related work'),
  },
  async ({ tasks: taskDefs }) => {
    await boot();
    await syncWorkersViaKeychain();

    for (const def of taskDefs) {
      if (!/^[a-zA-Z0-9_-]+$/.test(def.agent_id)) {
        return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${def.agent_id}"` }] };
      }
    }

    // Split native vs custom tasks (same pattern as gossip_dispatch_parallel)
    const nativeTasks: Array<{ agent_id: string; task: string }> = [];
    const relayTasks: Array<{ agent_id: string; task: string }> = [];
    for (const def of taskDefs) {
      if (nativeAgentConfigs.has(def.agent_id)) {
        nativeTasks.push(def);
      } else {
        relayTasks.push(def);
      }
    }

    const lines: string[] = [];
    const allTaskIds: string[] = [];

    // Dispatch relay tasks with consensus
    if (relayTasks.length > 0) {
      const { taskIds, errors } = await mainAgent.dispatchParallel(
        relayTasks.map((d: any) => ({ agentId: d.agent_id, task: d.task })),
        { consensus: true },
      );
      for (const tid of taskIds) {
        const t = mainAgent.getTask(tid);
        lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
        allTaskIds.push(tid);
      }
      if (errors.length) lines.push(`Relay errors: ${errors.join(', ')}`);
    }

    // Native tasks — inject consensus instruction into the prompt
    const consensusInstruction = '\n\n## Required Output Format\nInclude a "## Consensus Summary" section at the end with:\n- Key findings (bulleted)\n- Confidence level (high/medium/low) for each\n- Areas of uncertainty';
    const nativeInstructions: string[] = [];
    for (const def of nativeTasks) {
      const nativeConfig = nativeAgentConfigs.get(def.agent_id)!;
      const taskId = randomUUID().slice(0, 8);
      nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now() });
      allTaskIds.push(taskId);

      const agentPrompt = (nativeConfig.instructions || '') + consensusInstruction + `\n\n---\n\nTask: ${def.task}`;
      lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
      nativeInstructions.push(
        `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}, run_in_background: true)` +
        `\n  → then: gossip_relay_result(task_id: "${taskId}", result: "<output>")`
      );
    }

    let msg = `Dispatched ${taskDefs.length} tasks with consensus:\n${lines.join('\n')}`;
    msg += '\n\nAgents will include ## Consensus Summary in output.';
    msg += `\nCall gossip_collect_consensus with task IDs: [${allTaskIds.map(id => `"${id}"`).join(', ')}]`;
    if (nativeInstructions.length > 0) {
      msg += `\n\nNATIVE_DISPATCH: Execute these ${nativeInstructions.length} Agent calls, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
      msg += `\n\n⚠️ You MUST call gossip_relay_result for EVERY native agent after it completes. Without it, results are lost — no memory, no consensus cross-review.`;
    }
    return { content: [{ type: 'text' as const, text: msg }] };
  }
);

// ── Consensus: collect with cross-review ─────────────────────────────────
server.tool(
  'gossip_collect_consensus',
  'Collect results and run consensus cross-review. Each agent reviews peer findings, producing agree/disagree/new judgments. Returns agent results + tagged consensus report (CONFIRMED/DISPUTED/UNIQUE/NEW). Writes signals to agent-performance.jsonl.',
  {
    task_ids: z.array(z.string()).describe('Task IDs from gossip_dispatch_consensus'),
    timeout_ms: z.number().default(300000).describe('Max wait time in ms. Default 300000 (5min).'),
  },
  async ({ task_ids, timeout_ms }) => {
    await boot();

    // Split relay vs native task IDs
    const relayIds = task_ids.filter(id => !nativeResultMap.has(id) && !nativeTaskMap.has(id));
    const nativeIds = task_ids.filter(id => nativeResultMap.has(id) || nativeTaskMap.has(id));

    let collected;
    try {
      if (relayIds.length > 0) {
        collected = await mainAgent.collect(relayIds, timeout_ms, { consensus: true });
      } else {
        collected = { results: [], consensus: undefined };
      }
    } catch (err) {
      collected = { results: [], consensus: undefined };
      process.stderr.write(`[gossipcat] consensus collect failed: ${(err as Error).message}\n`);
    }

    const allResults = [...collected.results];

    // Include native results
    for (const id of nativeIds) {
      const nr = nativeResultMap.get(id);
      if (nr) {
        allResults.push(nr);
        nativeResultMap.delete(id);
      } else if (nativeTaskMap.has(id)) {
        allResults.push({ id, agentId: nativeTaskMap.get(id)!.agentId, task: nativeTaskMap.get(id)!.task, status: 'running' as const });
      }
    }

    if (allResults.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matching tasks. Native agents may still be running — call gossip_relay_result first.' }] };
    }

    const resultTexts = allResults.map((t: any) => {
      const dur = t.completedAt && t.startedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
      const nativeTag = nativeAgentConfigs.has(t.agentId) ? ' (native)' : '';
      if (t.status === 'completed') return `[${t.id}] ${t.agentId}${nativeTag} (${dur}):\n${t.result}`;
      if (t.status === 'failed') return `[${t.id}] ${t.agentId}${nativeTag} (${dur}): ERROR: ${t.error}`;
      return `[${t.id}] ${t.agentId}${nativeTag}: still running...`;
    });

    let output = resultTexts.join('\n\n---\n\n');

    if (collected.consensus) {
      output += '\n\n' + collected.consensus.summary;
    } else if (allResults.filter((t: any) => t.status === 'completed').length >= 2) {
      output += '\n\n⚠️ Consensus cross-review only runs on relay agents. Native agent results are included but not cross-reviewed by the relay engine.';
    } else {
      output += '\n\n⚠️ Consensus cross-review did not run (need ≥2 successful agents).';
    }

    return { content: [{ type: 'text' as const, text: output }] };
  }
);

// ── Info: list agents ─────────────────────────────────────────────────────
server.tool(
  'gossip_agents',
  'List all available agents: gossipcat workers AND Claude Code subagents (.claude/agents/) connected to the relay. All agents support gossip_dispatch and consensus.',
  {},
  async () => {
    const { findConfigPath, loadConfig, configToAgentConfigs, loadClaudeSubagents } = await import('./config');
    const sections: string[] = [];

    // Gossipcat agents from config
    const configPath = findConfigPath();
    const gossipAgents: string[] = [];
    const existingIds = new Set<string>();
    if (configPath) {
      const config = loadConfig(configPath);
      const agents = configToAgentConfigs(config);
      for (const a of agents) {
        existingIds.add(a.id);
        gossipAgents.push(`  - ${a.id}: ${a.provider}/${a.model} (${a.preset || 'custom'}) — skills: ${a.skills.join(', ')}`);
      }
      sections.push(`Orchestrator: ${config.main_agent.model} (${config.main_agent.provider})`);
    }

    // Claude Code subagents loaded into relay
    const claudeSubagents = loadClaudeSubagents(process.cwd(), existingIds);
    for (const sa of claudeSubagents) {
      gossipAgents.push(`  - ${sa.id}: ${sa.provider}/${sa.model} (claude-subagent) — ${sa.description.slice(0, 60)}`);
    }

    if (gossipAgents.length > 0) {
      sections.push(`\nAgents on relay (${gossipAgents.length}):\n${gossipAgents.join('\n')}`);
    } else {
      sections.push('\nNo agents configured. Run gossip_setup or add .claude/agents/*.md files.');
    }

    // Show runtime worker status if booted
    if (booted && workers.size > 0) {
      sections.push(`\nRelay workers online: ${workers.size} — [${Array.from(workers.keys()).join(', ')}]`);
    }

    return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
  }
);

// ── Info: status ──────────────────────────────────────────────────────────
server.tool(
  'gossip_status',
  'Check Gossip Mesh system status, host environment, and available agents',
  {},
  async () => {
    const { loadClaudeSubagents } = await import('./config');
    const claudeCount = loadClaudeSubagents(process.cwd()).length;
    return { content: [{ type: 'text' as const, text: [
      'Gossip Mesh Status:',
      `  Host: ${env.host}${env.supportsNativeAgents ? ' (native agents supported)' : ''}`,
      `  Native agent dir: ${env.nativeAgentDir || 'n/a'}`,
      `  Relay: ${relay ? `running :${relay.port}` : 'not started'}`,
      `  Tool Server: ${toolServer ? 'running' : 'not started'}`,
      `  Workers: ${workers.size} (${Array.from(workers.keys()).join(', ') || 'none'})`,
      `  Claude subagents found: ${claudeCount}`,
    ].join('\n') }] };
  }
);

// ── Tool: update agent instructions (supports batch) ─────────────────────
server.tool(
  'gossip_update_instructions',
  'Update one or more worker agents\' instructions. Accepts a single agent_id or an array of agent_ids for batch updates.',
  {
    agent_ids: z.union([z.string(), z.array(z.string())]).describe('Single agent ID or array of agent IDs to update'),
    instruction_update: z.string().describe('New instructions content (max 5000 chars)'),
    mode: z.enum(['append', 'replace']).describe('"append" to add to existing, "replace" to overwrite'),
  },
  async ({ agent_ids, instruction_update, mode }) => {
    await boot();

    // Size limit
    if (instruction_update.length > 5000) {
      return { content: [{ type: 'text' as const, text: 'Instruction update exceeds 5000 char limit.' }] };
    }

    // Block shell commands and code execution patterns (case-insensitive, whitespace-flexible)
    const blockedPatterns = [
      /rm\s+(-\w*[rf]|--force|--recursive)/i,
      /curl\s/i, /wget\s/i,
      /\beval\s*\(/i, /\bexec\s*\(/i, /\bspawn\s*\(/i,
      /\bimport\s*\(/i, /\brequire\s*\(/i,
      /process\.(env|exit|kill)/i,
      /child_process/i,
    ];
    if (blockedPatterns.some(p => p.test(instruction_update))) {
      return { content: [{ type: 'text' as const, text: 'Instruction update contains blocked content.' }] };
    }

    const ids = Array.isArray(agent_ids) ? agent_ids : [agent_ids];
    const results: string[] = [];
    const { writeFileSync: writeFS, mkdirSync: mkdirFS } = require('fs');
    const { join: joinPath } = require('path');

    for (const agent_id of ids) {
      if (!/^[a-zA-Z0-9_-]+$/.test(agent_id)) {
        results.push(`${agent_id}: invalid ID format`);
        continue;
      }

      const worker = mainAgent.getWorker(agent_id);
      if (!worker) {
        results.push(`${agent_id}: not found`);
        continue;
      }

      // Backup before replace
      if (mode === 'replace') {
        const agentDir = joinPath(process.cwd(), '.gossip', 'agents', agent_id);
        mkdirFS(agentDir, { recursive: true });
        writeFS(joinPath(agentDir, 'instructions-backup.md'), worker.getInstructions());
      }

      if (mode === 'replace') {
        worker.setInstructions(instruction_update);
      } else {
        worker.setInstructions(worker.getInstructions() + '\n\n' + instruction_update);
      }

      // Persist
      const agentDir = joinPath(process.cwd(), '.gossip', 'agents', agent_id);
      mkdirFS(agentDir, { recursive: true });
      writeFS(joinPath(agentDir, 'instructions.md'), worker.getInstructions());
      results.push(`${agent_id}: updated (${mode})`);
    }

    return { content: [{ type: 'text' as const, text: results.join('\n') }] };
  }
);

// ── Tool: bootstrap — generate team context prompt ────────────────────────
server.tool(
  'gossip_bootstrap',
  'Generate team context prompt with live agent state. Refreshes .gossip/bootstrap.md.',
  {},
  async () => {
    const { BootstrapGenerator } = await import('@gossip/orchestrator');
    const generator = new BootstrapGenerator(process.cwd());
    const result = generator.generate();
    const { writeFileSync, mkdirSync } = require('fs');
    const { join } = require('path');
    mkdirSync(join(process.cwd(), '.gossip'), { recursive: true });
    writeFileSync(join(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
    return { content: [{ type: 'text' as const, text: result.prompt }] };
  }
);

// ── Tool: setup — create or update team config ────────────────────────────
server.tool(
  'gossip_setup',
  `Create or update gossipcat team. Detects host environment (${env.host}) and supports both native Claude Code subagents (.claude/agents/*.md) and custom provider agents (Anthropic, OpenAI, Google Gemini). Pass agents array — each agent specifies its type.`,
  {
    main_provider: z.enum(['anthropic', 'openai', 'google']).default('google')
      .describe('Provider for the orchestrator LLM'),
    main_model: z.string().default('gemini-2.5-pro')
      .describe('Model ID for orchestrator (e.g. gemini-2.5-pro, claude-sonnet-4-6, gpt-4o)'),
    agents: z.array(z.object({
      id: z.string().describe('Agent ID (lowercase, hyphens). e.g. "claude-reviewer", "gemini-impl"'),
      type: z.enum(['native', 'custom']).describe(
        '"native" = Claude Code subagent (.claude/agents/*.md), uses Anthropic API on the relay. ' +
        '"custom" = any provider (anthropic/openai/google/local)'
      ),
      // Native agent fields
      model: z.enum(['opus', 'sonnet', 'haiku']).optional()
        .describe('For native agents: Claude model tier'),
      description: z.string().optional()
        .describe('For native agents: one-line description for the .claude/agents/*.md frontmatter'),
      instructions: z.string().optional()
        .describe('For native agents: full instructions (markdown body of .claude/agents/*.md)'),
      // Custom agent fields
      provider: z.enum(['anthropic', 'openai', 'google', 'local']).optional()
        .describe('For custom agents: LLM provider'),
      custom_model: z.string().optional()
        .describe('For custom agents: model ID (e.g. gemini-2.5-pro, gpt-4o, claude-sonnet-4-6)'),
      // Shared fields
      preset: z.enum(['implementer', 'reviewer', 'researcher', 'tester']).optional()
        .describe('Agent role preset'),
      skills: z.array(z.string()).optional()
        .describe('Skill tags (e.g. ["typescript", "code_review"])'),
    })).describe('Array of agents to create'),
  },
  async ({ main_provider, main_model, agents }) => {
    const { writeFileSync, mkdirSync, existsSync } = require('fs');
    const { join } = require('path');
    const root = process.cwd();

    const CLAUDE_MODEL_MAP: Record<string, { provider: string; model: string }> = {
      opus:   { provider: 'anthropic', model: 'claude-opus-4-6' },
      sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      haiku:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
    };

    const configAgents: Record<string, any> = {};
    const nativeCreated: string[] = [];
    const customCreated: string[] = [];
    const errors: string[] = [];

    for (const agent of agents) {
      if (agent.type === 'native') {
        // Create .claude/agents/<id>.md
        const modelTier = agent.model || 'sonnet';
        const mapped = CLAUDE_MODEL_MAP[modelTier];
        if (!mapped) {
          errors.push(`${agent.id}: unknown model tier "${modelTier}"`);
          continue;
        }

        const desc = agent.description || `${agent.preset || 'general'} agent`;
        const body = agent.instructions || `You are a ${agent.preset || 'skilled developer'} agent. Complete assigned tasks using available tools. Be concise and focused.`;
        const tools = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write'];
        const md = [
          '---',
          `name: ${agent.id}`,
          `model: ${modelTier}`,
          `description: ${desc}`,
          `tools:`,
          ...tools.map(t => `  - ${t}`),
          '---',
          '',
          body,
        ].join('\n');

        const agentsDir = join(root, '.claude', 'agents');
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(join(agentsDir, `${agent.id}.md`), md, 'utf-8');
        nativeCreated.push(agent.id);

        // Register in gossipcat config — marked native so dispatch uses Agent tool bridge
        configAgents[agent.id] = {
          provider: mapped.provider,
          model: mapped.model,
          preset: agent.preset || 'implementer',
          skills: agent.skills || ['general'],
          native: true,
        };
      } else {
        // Custom provider agent → gossipcat config only
        if (!agent.provider) {
          errors.push(`${agent.id}: custom agent requires "provider" field`);
          continue;
        }
        if (!agent.custom_model) {
          errors.push(`${agent.id}: custom agent requires "custom_model" field`);
          continue;
        }
        configAgents[agent.id] = {
          provider: agent.provider,
          model: agent.custom_model,
          preset: agent.preset || 'implementer',
          skills: agent.skills || ['general'],
        };
        customCreated.push(agent.id);

        // Write instructions if provided
        if (agent.instructions) {
          const instrDir = join(root, '.gossip', 'agents', agent.id);
          mkdirSync(instrDir, { recursive: true });
          writeFileSync(join(instrDir, 'instructions.md'), agent.instructions, 'utf-8');
        }
      }
    }

    // Write gossipcat config
    const config = {
      main_agent: { provider: main_provider, model: main_model },
      agents: configAgents,
    };

    try {
      const { validateConfig } = await import('./config');
      validateConfig(config);
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Invalid config: ${(err as Error).message}` }] };
    }

    mkdirSync(join(root, '.gossip'), { recursive: true });
    writeFileSync(join(root, '.gossip', 'config.json'), JSON.stringify(config, null, 2));

    // Generate host-appropriate rules file so the IDE knows about the team
    const agentList = Object.entries(configAgents)
      .map(([id, a]: [string, any]) => `- ${id}: ${a.provider}/${a.model} (${a.preset || 'custom'})`)
      .join('\n');
    const rulesDir = join(root, env.rulesDir);
    const rulesFile = join(root, env.rulesFile);
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(rulesFile, `# Gossipcat — Multi-Agent Orchestration

This project uses gossipcat for multi-agent orchestration via MCP.

## Team Setup
When the user asks to set up agents, review code with multiple agents, or build with a team, use the gossipcat MCP tools.

### Creating agents
Use \`gossip_setup\` with an agents array. Each agent can be:
- **type: "native"** — Creates a Claude Code subagent (.claude/agents/*.md) that ALSO connects to the gossipcat relay. Works both as a native Agent() and via gossip_dispatch(). Supports consensus cross-review.
- **type: "custom"** — Any provider (anthropic, openai, google, local). Only accessible via gossip_dispatch().

### Dispatching work
**READ tasks** (review, research, analysis):
\`\`\`
gossip_dispatch(agent_id: "<id>", task: "Review X for security issues")
gossip_dispatch_parallel(tasks: [{agent_id: "<id>", task: "..."}, ...])
gossip_collect(task_ids: ["..."])
\`\`\`

**WRITE tasks** (implementation, bug fixes):
\`\`\`
gossip_dispatch(agent_id: "<id>", task: "Fix X", write_mode: "scoped", scope: "./src")
\`\`\`

**Consensus** (cross-review for quality):
\`\`\`
gossip_dispatch_consensus(task: "Review this PR for issues")
gossip_collect_consensus(task_ids: ["..."])
\`\`\`

**Plan → Execute** (structured multi-step):
\`\`\`
gossip_plan(task: "Build feature X")  → returns dispatch-ready JSON
gossip_dispatch_parallel(tasks: <plan JSON>)
gossip_collect(task_ids: [...])
\`\`\`

## Available Agents
${agentList}

## When to Use Multi-Agent Dispatch
| Task | Why Multi-Agent | Split Strategy |
|------|----------------|----------------|
| Security review | Different agents catch different vuln classes | Split by package/concern |
| Code review | Cross-validation catches what single reviewers miss | Split by concern |
| Bug investigation | Competing hypotheses tested in parallel | One hypothesis per agent |
| Feature implementation | Parallel modules, faster delivery | Split by module with scoped writes |

Single agent is fine for: quick lookups, simple tasks, running tests.

## CRITICAL: Native Agent Relay Rule

When you dispatch a native agent via \`gossip_dispatch\`, you get back a NATIVE_DISPATCH response
with a task_id. You MUST follow this exact flow:

1. Call \`gossip_dispatch(agent_id, task)\` → get task_id
2. Run \`Agent(model, prompt)\` as instructed
3. **ALWAYS** call \`gossip_relay_result(task_id, result)\` after the agent completes

Never call Agent() directly for gossipcat agents — always go through gossip_dispatch first
so the task is tracked. Never skip gossip_relay_result — without it, the result is invisible
to memory, gossip, and consensus.

## Permissions for Native Agents

Native agents run via Claude Code's Agent tool. Subagents may prompt for file write permissions.
To auto-allow, add to \`.claude/settings.local.json\`:

\`\`\`json
{
  "permissions": {
    "allow": ["Edit", "Write", "Bash(npm *)"]
  }
}
\`\`\`

You can scope permissions to specific directories: \`"Edit(src/**)"\`, \`"Write(plans/**)"\`.
`);

    // Summary
    const lines: string[] = [`Host: ${env.host}`, ''];
    if (nativeCreated.length > 0) {
      lines.push(`Native agents created (${nativeCreated.length}):`);
      lines.push(...nativeCreated.map(id => `  ✓ .claude/agents/${id}.md → also on gossipcat relay`));
    }
    if (customCreated.length > 0) {
      lines.push(`Custom agents created (${customCreated.length}):`);
      lines.push(...customCreated.map(id => `  ✓ ${id} → ${configAgents[id].provider}/${configAgents[id].model}`));
    }
    if (errors.length > 0) {
      lines.push(`\nErrors (${errors.length}):`);
      lines.push(...errors.map(e => `  ✗ ${e}`));
    }
    lines.push(`\nConfig: .gossip/config.json (${Object.keys(configAgents).length} agents)`);
    lines.push(`Rules: ${env.rulesFile} (${env.host} will read this on next session)`);
    lines.push('Agents will connect to relay on first gossip_dispatch() call.');
    if (nativeCreated.length > 0) {
      lines.push(`\nTip: Native agents may prompt for file write permissions. To auto-allow, add to .claude/settings.local.json:`);
      lines.push(`  { "permissions": { "allow": ["Edit", "Write"] } }`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

// ── Native agent bridge: feed Agent tool results back into relay ──────────
server.tool(
  'gossip_relay_result',
  'Feed a native agent result back into the gossipcat relay. Call this after a Claude Code Agent() completes a task dispatched via gossip_dispatch for a native agent. Enables consensus cross-review and gossip for native agents.',
  {
    task_id: z.string().describe('Task ID returned by gossip_dispatch'),
    result: z.string().describe('The agent output/result text'),
    error: z.string().optional().describe('Error message if the agent failed'),
  },
  async ({ task_id, result, error }) => {
    await boot(); // [H3 fix] ensure mainAgent/pipeline are available

    const taskInfo = nativeTaskMap.get(task_id);
    if (!taskInfo) {
      return { content: [{ type: 'text' as const, text: `Unknown task ID: ${task_id}. Was it dispatched via gossip_dispatch?` }] };
    }

    nativeTaskMap.delete(task_id);
    const elapsed = Date.now() - taskInfo.startedAt;

    // Evict stale entries from nativeTaskMap (TTL: 30 min) [H1 fix]
    const TTL_MS = 30 * 60 * 1000;
    const now = Date.now();
    for (const [id, info] of nativeTaskMap) {
      if (now - info.startedAt > TTL_MS) nativeTaskMap.delete(id);
    }

    // Run the same post-collect pipeline as custom agents:
    // 1. Memory write  2. Knowledge extraction  3. Gossip  4. Compaction
    const agentId = taskInfo.agentId;
    const agentSkills = (() => {
      try { return mainAgent.getAgentList().find((a: any) => a.id === agentId)?.skills || []; }
      catch { return []; }
    })();

    if (!error) {
      // 1. Write task entry to memory
      try {
        const { MemoryWriter, MemoryCompactor } = await import('@gossip/orchestrator');
        const memWriter = new MemoryWriter(process.cwd());
        await memWriter.writeTaskEntry(agentId, {
          taskId: task_id,
          task: taskInfo.task,
          skills: agentSkills,
          scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
        });

        // 2. Extract knowledge from result (files, tech, decisions)
        if (result) {
          memWriter.writeKnowledgeFromResult(agentId, {
            taskId: task_id, task: taskInfo.task, result: result.slice(0, 4000),
          });
        }

        memWriter.rebuildIndex(agentId);

        // 3. Compact memory if needed
        const compactor = new MemoryCompactor(process.cwd());
        compactor.compactIfNeeded(agentId);
      } catch (err) {
        process.stderr.write(`[gossipcat] Memory write failed for ${agentId}: ${(err as Error).message}\n`);
      }
    }

    // 4. Publish gossip so other running agents can see this result
    try {
      const pipeline = (mainAgent as any).pipeline ?? (mainAgent as any)._pipeline;
      if (pipeline?.summarizeAndStoreGossip && !error) {
        pipeline.summarizeAndStoreGossip(agentId, result);
      }
    } catch { /* gossip summarization is best-effort */ }

    // 5. Store in collected results map so gossip_collect can find it
    nativeResultMap.set(task_id, {
      id: task_id,
      agentId,
      task: taskInfo.task,
      status: error ? 'failed' : 'completed',
      result: error ? undefined : result,
      error: error || undefined,
      startedAt: taskInfo.startedAt,
      completedAt: Date.now(),
    });

    const status = error ? `failed (${elapsed}ms): ${error}` : `completed (${elapsed}ms)`;
    return { content: [{ type: 'text' as const, text: `Result relayed for ${agentId} [${task_id}]: ${status}\n\nThe result is now available for gossip_collect and consensus cross-review.` }] };
  }
);

// ── Tool: list available gossipcat tools ──────────────────────────────────
server.tool(
  'gossip_tools',
  'List all available gossipcat MCP tools with descriptions. Call after /mcp reconnect to discover new tools.',
  {},
  async () => {
    const tools = [
      { name: 'gossip_plan', desc: 'Plan a task with write-mode suggestions. Returns dispatch-ready JSON for approval before execution.' },
      { name: 'gossip_dispatch', desc: 'Send task to a specific agent (skills auto-injected)' },
      { name: 'gossip_dispatch_parallel', desc: 'Fan out tasks to multiple agents simultaneously' },
      { name: 'gossip_collect', desc: 'Collect results from dispatched tasks' },
      { name: 'gossip_dispatch_consensus', desc: 'Dispatch with consensus summary instruction. Returns task IDs.' },
      { name: 'gossip_collect_consensus', desc: 'Collect + cross-review. Returns tagged CONFIRMED/DISPUTED/UNIQUE/NEW report.' },
      { name: 'gossip_orchestrate', desc: 'Submit task for multi-agent execution via MainAgent' },
      { name: 'gossip_agents', desc: 'List configured agents with provider, model, role, skills' },
      { name: 'gossip_status', desc: 'Check relay, tool-server, workers status' },
      { name: 'gossip_update_instructions', desc: 'Update agent instructions (single or batch). Modes: append/replace' },
      { name: 'gossip_relay_result', desc: 'Feed native Agent tool result back into relay for consensus' },
      { name: 'gossip_tools', desc: 'List available tools (this command)' },
      { name: 'gossip_bootstrap', desc: 'Generate team context prompt with live agent state' },
      { name: 'gossip_setup', desc: 'Create or update team configuration' },
    ];
    const list = tools.map(t => `- ${t.name}: ${t.desc}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Gossipcat Tools (${tools.length}):\n\n${list}` }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => { process.stderr.write(`[gossipcat] Fatal: ${err.message}\n`); process.exit(1); });
