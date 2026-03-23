#!/usr/bin/env node
/**
 * Gossipcat MCP Server — thin adapter over MainAgent/DispatchPipeline
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';

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

  // Create workers before MainAgent to avoid duplicate relay connections
  for (const ac of agentConfigs) {
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

    const configPath = m.findConfigPath();
    if (!configPath) return;

    const config = m.loadConfig(configPath);
    const agentConfigs = m.configToAgentConfigs(config);

    // Register any new agent configs
    for (const ac of agentConfigs) {
      mainAgent.registerAgent(ac);
    }

    const added = await mainAgent.syncWorkers((provider: string) => keychain.getKey(provider));
    if (added > 0) {
      // Sync new workers into the module-level map for gossip_status visibility
      for (const ac of agentConfigs) {
        if (!workers.has(ac.id)) {
          const w = mainAgent.getWorker(ac.id);
          if (w) workers.set(ac.id, w);
        }
      }
      process.stderr.write(`[gossipcat] Synced: ${workers.size} workers total\n`);
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
      const response = await mainAgent.handleMessage(task);
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
        // Fallback: use the first agent that has an API key
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
  'Fan out tasks to multiple agents simultaneously. For tasks involving file modifications, use gossip_plan first to get a pre-built task array with write modes, then pass it here. The PLAN_JSON from gossip_plan is directly passable as the tasks parameter.',
  {
    tasks: z.array(z.object({
      agent_id: z.string(),
      task: z.string(),
      write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional(),
      scope: z.string().optional(),
    })).describe('Array of { agent_id, task, write_mode?, scope? }'),
  },
  async ({ tasks: taskDefs }) => {
    await boot();
    await syncWorkersViaKeychain();

    // Validate all agent IDs before dispatching
    for (const def of taskDefs) {
      if (!/^[a-zA-Z0-9_-]+$/.test(def.agent_id)) {
        return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${def.agent_id}"` }] };
      }
    }

    const { taskIds, errors } = await mainAgent.dispatchParallel(
      taskDefs.map((d: any) => ({
        agentId: d.agent_id,
        task: d.task,
        options: d.write_mode ? { writeMode: d.write_mode, scope: d.scope } : undefined,
      }))
    );

    let msg = `Dispatched ${taskIds.length} tasks:\n${taskIds.map((tid: string) => {
      const t = mainAgent.getTask(tid);
      return `  ${tid} → ${t?.agentId || 'unknown'}`;
    }).join('\n')}`;
    if (errors.length) msg += `\nErrors: ${errors.join(', ')}`;
    return { content: [{ type: 'text' as const, text: msg }] };
  }
);

// ── Low-level: collect results ────────────────────────────────────────────
server.tool(
  'gossip_collect',
  'Collect results from dispatched tasks. Waits for completion by default.',
  {
    task_ids: z.array(z.string()).optional().describe('Task IDs to collect. Omit for all.'),
    timeout_ms: z.number().optional().describe('Max wait time. Default 120000.'),
  },
  async ({ task_ids, timeout_ms }) => {
    let collected;
    try {
      collected = await mainAgent.collect(task_ids, timeout_ms);
    } catch (err) {
      process.stderr.write(`[gossipcat] collect failed: ${(err as Error).message}\n`);
      return { content: [{ type: 'text' as const, text: `Collect error: ${(err as Error).message}` }] };
    }

    if (collected.length === 0) {
      return { content: [{ type: 'text' as const, text: task_ids ? 'No matching tasks.' : 'No pending tasks.' }] };
    }

    const results = collected.map((t: any) => {
      const dur = t.completedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
      const modeTag = t.writeMode ? ` [${t.writeMode}${t.scope ? `:${t.scope}` : ''}]` : '';
      let text: string;
      if (t.status === 'completed') text = `[${t.id}] ${t.agentId}${modeTag} (${dur}):\n${t.result}`;
      else if (t.status === 'failed') text = `[${t.id}] ${t.agentId}${modeTag} (${dur}): ERROR: ${t.error}`;
      else text = `[${t.id}] ${t.agentId}${modeTag}: still running...`;

      if (t.worktreeInfo) {
        text += `\n📁 Worktree: ${t.worktreeInfo.path} (branch: ${t.worktreeInfo.branch})`;
      }
      if (t.skillWarnings?.length) {
        text += `\n\n⚠️ Skill coverage gaps:\n${t.skillWarnings.map((w: string) => `  - ${w}`).join('\n')}`;
      }
      return text;
    });

    return { content: [{ type: 'text' as const, text: results.join('\n\n---\n\n') }] };
  }
);

// ── Info: list agents ─────────────────────────────────────────────────────
server.tool(
  'gossip_agents',
  'List configured agents with provider, model, role, and skills',
  {},
  async () => {
    const { findConfigPath, loadConfig, configToAgentConfigs } = await import('./config');
    const configPath = findConfigPath();
    if (!configPath) return { content: [{ type: 'text' as const, text: 'No gossip.agents.json found.' }] };
    const config = loadConfig(configPath);
    const agents = configToAgentConfigs(config);
    const list = agents.map((a: any) => `- ${a.id}: ${a.provider}/${a.model} (${a.preset || 'custom'}) — skills: ${a.skills.join(', ')}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Orchestrator: ${config.main_agent.model} (${config.main_agent.provider})\n\nAgents:\n${list}` }] };
  }
);

// ── Info: status ──────────────────────────────────────────────────────────
server.tool(
  'gossip_status',
  'Check Gossip Mesh system status',
  {},
  async () => {
    return { content: [{ type: 'text' as const, text: [
      'Gossip Mesh Status:',
      `  Relay: ${relay ? `running :${relay.port}` : 'not started'}`,
      `  Tool Server: ${toolServer ? 'running' : 'not started'}`,
      `  Workers: ${workers.size} (${Array.from(workers.keys()).join(', ') || 'none'})`,
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
  'Create or update gossipcat team configuration. Writes .gossip/config.json.',
  {
    config: z.object({
      main_agent: z.object({
        provider: z.string(),
        model: z.string(),
      }),
      // z.record() is incompatible with MCP SDK's JSON Schema converter in zod v4
      // Using z.any() for the schema; actual validation done by validateConfig() below
      agents: z.any().optional().describe('Record of agent_id → { provider, model, preset?, skills[] }'),
    }),
  },
  async ({ config }) => {
    try {
      const { validateConfig } = await import('./config');
      validateConfig(config);
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Invalid config: ${(err as Error).message}` }] };
    }

    const { writeFileSync, mkdirSync } = require('fs');
    const { join } = require('path');
    mkdirSync(join(process.cwd(), '.gossip'), { recursive: true });
    writeFileSync(join(process.cwd(), '.gossip', 'config.json'), JSON.stringify(config, null, 2));

    const agentCount = Object.keys(config.agents || {}).length;
    return { content: [{ type: 'text' as const, text: `Config saved. ${agentCount} agents configured. Agents will start on first dispatch — call gossip_dispatch() to begin.` }] };
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
      { name: 'gossip_orchestrate', desc: 'Submit task for multi-agent execution via MainAgent' },
      { name: 'gossip_agents', desc: 'List configured agents with provider, model, role, skills' },
      { name: 'gossip_status', desc: 'Check relay, tool-server, workers status' },
      { name: 'gossip_update_instructions', desc: 'Update agent instructions (single or batch). Modes: append/replace' },
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
