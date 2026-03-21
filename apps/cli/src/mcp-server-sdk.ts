#!/usr/bin/env node
/**
 * Gossipcat MCP Server — thin adapter over MainAgent/DispatchPipeline
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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

  const mainKey = await keychain.getKey(config.main_agent.provider);
  mainAgent = new m.MainAgent({
    provider: config.main_agent.provider,
    model: config.main_agent.model,
    apiKey: mainKey ?? undefined,
    relayUrl: relay.url,
    agents: agentConfigs,
    projectRoot: process.cwd(),
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

// ── Low-level: dispatch to specific agent ─────────────────────────────────
server.tool(
  'gossip_dispatch',
  'Send a task to a specific agent. Returns task ID for collecting results. Skills are auto-injected from the agent config — no need to pass them. The agent can read files itself via the Tool Server — pass file paths in the task, not file contents.',
  {
    agent_id: z.string().describe('Agent ID (e.g. "gemini-reviewer")'),
    task: z.string().describe('Task description. Reference file paths — the agent will read them via Tool Server.'),
  },
  async ({ agent_id, task }) => {
    await boot();
    await syncWorkersViaKeychain();

    if (!/^[a-zA-Z0-9_-]+$/.test(agent_id)) {
      return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${agent_id}"` }] };
    }

    try {
      const { taskId } = mainAgent.dispatch(agent_id, task);
      return { content: [{ type: 'text' as const, text: `Dispatched to ${agent_id}. Task ID: ${taskId}` }] };
    } catch (err: any) {
      process.stderr.write(`[gossipcat] dispatch failed: ${err.message}\n`);
      return { content: [{ type: 'text' as const, text: err.message }] };
    }
  }
);

// ── Low-level: parallel dispatch ──────────────────────────────────────────
server.tool(
  'gossip_dispatch_parallel',
  'Fan out tasks to multiple agents simultaneously. Skills are auto-injected. Agents read files via Tool Server.',
  {
    tasks: z.array(z.object({
      agent_id: z.string(),
      task: z.string(),
    })).describe('Array of { agent_id, task }'),
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

    // Map underscore agent_id → camelCase agentId
    const { taskIds, errors } = mainAgent.dispatchParallel(
      taskDefs.map((d: { agent_id: string; task: string }) => ({ agentId: d.agent_id, task: d.task }))
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
      let text: string;
      if (t.status === 'completed') text = `[${t.id}] ${t.agentId} (${dur}):\n${t.result}`;
      else if (t.status === 'failed') text = `[${t.id}] ${t.agentId} (${dur}): ERROR: ${t.error}`;
      else text = `[${t.id}] ${t.agentId}: still running...`;

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

// ── Tool: list available gossipcat tools ──────────────────────────────────
server.tool(
  'gossip_tools',
  'List all available gossipcat MCP tools with descriptions. Call after /mcp reconnect to discover new tools.',
  {},
  async () => {
    const tools = [
      { name: 'gossip_dispatch', desc: 'Send task to a specific agent (skills auto-injected)' },
      { name: 'gossip_dispatch_parallel', desc: 'Fan out tasks to multiple agents simultaneously' },
      { name: 'gossip_collect', desc: 'Collect results from dispatched tasks' },
      { name: 'gossip_orchestrate', desc: 'Submit task for multi-agent execution via MainAgent' },
      { name: 'gossip_agents', desc: 'List configured agents with provider, model, role, skills' },
      { name: 'gossip_status', desc: 'Check relay, tool-server, workers status' },
      { name: 'gossip_update_instructions', desc: 'Update agent instructions (single or batch). Modes: append/replace' },
      { name: 'gossip_tools', desc: 'List available tools (this command)' },
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
