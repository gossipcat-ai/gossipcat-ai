#!/usr/bin/env node
/**
 * Gossipcat MCP Server — using official @modelcontextprotocol/sdk
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// Lazy imports — only load heavy modules when first tool is called
let booted = false;
let bootPromise: Promise<void> | null = null;
let relay: any = null;
let toolServer: any = null;
let workers: Map<string, any> = new Map();
let mainAgent: any = null;
const tasks: Map<string, any> = new Map();

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
  bootPromise = doBoot();
  return bootPromise;
}

async function doBoot() {
  const m = await getModules();

  const configPath = m.findConfigPath();
  if (!configPath) throw new Error('No gossip.agents.json found. Run gossipcat setup first.');

  const config = m.loadConfig(configPath);
  const agentConfigs = m.configToAgentConfigs(config);
  const keychain = new m.Keychain();

  relay = new m.RelayServer({ port: 0 });
  await relay.start();

  toolServer = new m.ToolServer({ relayUrl: relay.url, projectRoot: process.cwd() });
  await toolServer.start();

  for (const ac of agentConfigs) {
    const key = await keychain.getKey(ac.provider);
    const llm = m.createProvider(ac.provider, ac.model, key ?? undefined);
    const worker = new m.WorkerAgent(ac.id, llm, relay.url, m.ALL_TOOLS);
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
  });
  await mainAgent.start();

  booted = true;
  process.stderr.write(`[gossipcat] Booted: relay :${relay.port}, ${workers.size} workers\n`);
}

/**
 * Hot-reload: re-read gossip.agents.json and spawn any new workers
 * that aren't already running. No restart needed.
 */
async function syncWorkers() {
  if (!booted) return;
  const m = await getModules();

  const configPath = m.findConfigPath();
  if (!configPath) return;

  const config = m.loadConfig(configPath);
  const agentConfigs = m.configToAgentConfigs(config);
  const keychain = new m.Keychain();

  let added = 0;
  for (const ac of agentConfigs) {
    if (workers.has(ac.id)) continue; // already running
    const key = await keychain.getKey(ac.provider);
    const llm = m.createProvider(ac.provider, ac.model, key ?? undefined);
    const worker = new m.WorkerAgent(ac.id, llm, relay.url, m.ALL_TOOLS);
    await worker.start();
    workers.set(ac.id, worker);
    added++;
    process.stderr.write(`[gossipcat] Hot-added agent: ${ac.id}\n`);
  }

  if (added > 0) {
    process.stderr.write(`[gossipcat] Synced: ${workers.size} workers total\n`);
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
    await syncWorkers(); // hot-reload new agents from config
    const worker = workers.get(agent_id);
    if (!worker) {
      return { content: [{ type: 'text' as const, text: `Agent "${agent_id}" not found. Available: ${Array.from(workers.keys()).join(', ')}` }] };
    }

    // Auto-inject skills from agent config
    const { loadSkills } = await import('./skill-loader-bridge');
    const skillsContent = loadSkills(agent_id, process.cwd());

    const taskId = randomUUID().slice(0, 8);
    const entry: any = { id: taskId, agentId: agent_id, task, status: 'running', startedAt: Date.now() };
    entry.promise = worker.executeTask(task, undefined, skillsContent)
      .then((result: string) => { entry.status = 'completed'; entry.result = result; entry.completedAt = Date.now(); })
      .catch((err: Error) => { entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now(); });
    tasks.set(taskId, entry);

    return { content: [{ type: 'text' as const, text: `Dispatched to ${agent_id}. Task ID: ${taskId}` }] };
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
    await syncWorkers(); // hot-reload new agents from config
    const { loadSkills } = await import('./skill-loader-bridge');
    const taskIds: string[] = [];
    const errors: string[] = [];

    for (const def of taskDefs) {
      const worker = workers.get(def.agent_id);
      if (!worker) { errors.push(`Agent "${def.agent_id}" not found`); continue; }

      const skillsContent = loadSkills(def.agent_id, process.cwd());
      const taskId = randomUUID().slice(0, 8);
      const entry: any = { id: taskId, agentId: def.agent_id, task: def.task, status: 'running', startedAt: Date.now() };
      entry.promise = worker.executeTask(def.task, undefined, skillsContent)
        .then((result: string) => { entry.status = 'completed'; entry.result = result; entry.completedAt = Date.now(); })
        .catch((err: Error) => { entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now(); });
      tasks.set(taskId, entry);
      taskIds.push(taskId);
    }

    let msg = `Dispatched ${taskIds.length} tasks:\n${taskIds.map((tid, i) => `  ${tid} → ${taskDefs[i].agent_id}`).join('\n')}`;
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
    const targets = task_ids
      ? task_ids.map(id => tasks.get(id)).filter(Boolean)
      : Array.from(tasks.values()).filter((t: any) => t.status === 'running');

    if (targets.length === 0) {
      return { content: [{ type: 'text' as const, text: task_ids ? 'No matching tasks.' : 'No pending tasks.' }] };
    }

    await Promise.race([
      Promise.all(targets.map((t: any) => t.promise)),
      new Promise(r => setTimeout(r, timeout_ms || 120_000)),
    ]);

    const results = targets.map((t: any) => {
      const dur = t.completedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
      if (t.status === 'completed') return `[${t.id}] ${t.agentId} (${dur}):\n${t.result}`;
      if (t.status === 'failed') return `[${t.id}] ${t.agentId} (${dur}): ERROR: ${t.error}`;
      return `[${t.id}] ${t.agentId}: still running...`;
    });

    for (const t of targets) { if (t.status !== 'running') tasks.delete(t.id); }
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
    const list = agents.map(a => `- ${a.id}: ${a.provider}/${a.model} (${a.preset || 'custom'}) — skills: ${a.skills.join(', ')}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Orchestrator: ${config.main_agent.model} (${config.main_agent.provider})\n\nAgents:\n${list}` }] };
  }
);

// ── Info: status ──────────────────────────────────────────────────────────
server.tool(
  'gossip_status',
  'Check Gossip Mesh system status',
  {},
  async () => {
    const pending = Array.from(tasks.values()).filter((t: any) => t.status === 'running');
    return { content: [{ type: 'text' as const, text: [
      'Gossip Mesh Status:',
      `  Relay: ${relay ? `running :${relay.port}` : 'not started'}`,
      `  Tool Server: ${toolServer ? 'running' : 'not started'}`,
      `  Workers: ${workers.size} (${Array.from(workers.keys()).join(', ') || 'none'})`,
      `  Pending tasks: ${pending.length}`,
    ].join('\n') }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => { process.stderr.write(`[gossipcat] Fatal: ${err.message}\n`); process.exit(1); });
