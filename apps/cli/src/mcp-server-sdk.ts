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
const batches = new Map<string, Set<string>>();
let gossipPublisher: any = null;
let agentConfigsCache: any[] = [];

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

  // Create workers at the MCP level for low-level dispatch (gossip_dispatch).
  // MainAgent.start() is NOT called — it would create duplicate workers
  // with the same agent IDs, causing "already connected" errors on the relay.
  for (const ac of agentConfigs) {
    const key = await keychain.getKey(ac.provider);
    const llm = m.createProvider(ac.provider, ac.model, key ?? undefined);
    const { existsSync: existsSyncBoot, readFileSync: readFileSyncBoot } = require('fs');
    const { join: joinBoot } = require('path');
    const instructionsPath = joinBoot(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
    const instructions = existsSyncBoot(instructionsPath)
      ? readFileSyncBoot(instructionsPath, 'utf-8')
      : undefined;

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
  });
  // Pass existing workers to MainAgent so it doesn't create duplicates
  mainAgent.setWorkers(workers);
  // start() will skip workers already set via setWorkers()
  await mainAgent.start();

  // Create gossip publisher for batch updates
  try {
    const { GossipAgent: GossipAgentPub } = await import('@gossip/client');
    const publisherAgent = new GossipAgentPub({
      agentId: 'gossip-publisher',
      relayUrl: relay.url,
      reconnect: true,
    });
    await publisherAgent.connect();

    const { GossipPublisher: GossipPub } = await import('@gossip/orchestrator');
    gossipPublisher = new GossipPub(
      m.createProvider(config.main_agent.provider, config.main_agent.model, mainKey ?? undefined),
      { publishToChannel: (channel: string, data: unknown) => publisherAgent.publishToChannel(channel, data) }
    );
    agentConfigsCache = agentConfigs;
    process.stderr.write(`[gossipcat] Gossip publisher ready\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Gossip publisher failed: ${(err as Error).message}\n`);
  }

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
    const { existsSync: existsSyncBoot, readFileSync: readFileSyncBoot } = require('fs');
    const { join: joinBoot } = require('path');
    const instructionsPath = joinBoot(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
    const instructions = existsSyncBoot(instructionsPath)
      ? readFileSyncBoot(instructionsPath, 'utf-8')
      : undefined;

    const worker = new m.WorkerAgent(ac.id, llm, relay.url, m.ALL_TOOLS, instructions);
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

    // Load agent memory and assemble prompt
    const { AgentMemoryReader, assemblePrompt } = await import('@gossip/orchestrator');
    const memoryReader = new AgentMemoryReader(process.cwd());
    const memoryContent = memoryReader.loadMemory(agent_id, task);
    const promptContent = assemblePrompt({
      memory: memoryContent || undefined,
      skills: skillsContent,
    });

    const { checkSkillCoverage } = await import('./skill-catalog-check');
    const cfgPath2 = (await import('./config')).findConfigPath();
    const agentSkills = cfgPath2
      ? (await import('./config')).configToAgentConfigs((await import('./config')).loadConfig(cfgPath2)).find((a: any) => a.id === agent_id)?.skills || []
      : [];
    const skillWarnings = checkSkillCoverage(agent_id, agentSkills, task, process.cwd());

    const taskId = randomUUID().slice(0, 8);
    const entry: any = { id: taskId, agentId: agent_id, task, status: 'running', startedAt: Date.now(), skillWarnings };
    entry.promise = worker.executeTask(task, undefined, promptContent)
      .then((result: string) => { entry.status = 'completed'; entry.result = result; entry.completedAt = Date.now(); })
      .catch((err: Error) => { entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now(); });
    tasks.set(taskId, entry);

    // Record task creation in TaskGraph
    try {
      const { TaskGraph } = await import('@gossip/orchestrator');
      const graph = new TaskGraph(process.cwd());
      graph.recordCreated(taskId, agent_id, task, agentSkills);
    } catch { /* non-blocking */ }

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

    const { checkSkillCoverage } = await import('./skill-catalog-check');
    const cfgPathP = (await import('./config')).findConfigPath();
    const allAgentConfigs = cfgPathP
      ? (await import('./config')).configToAgentConfigs((await import('./config')).loadConfig(cfgPathP))
      : [];

    const { AgentMemoryReader: AgentMemoryReaderP, assemblePrompt: assemblePromptP } = await import('@gossip/orchestrator');
    const memoryReaderP = new AgentMemoryReaderP(process.cwd());

    // Create batch for gossip
    const batchId = randomUUID().slice(0, 8);
    const batchTaskIds = new Set<string>();

    // Subscribe workers to batch channel
    for (const def of taskDefs) {
      const w = workers.get(def.agent_id);
      if (w?.subscribeToBatch) {
        w.subscribeToBatch(batchId).catch(() => {});
      }
    }

    for (const def of taskDefs) {
      const worker = workers.get(def.agent_id);
      if (!worker) { errors.push(`Agent "${def.agent_id}" not found`); continue; }

      const skillsContent = loadSkills(def.agent_id, process.cwd());

      // Load agent memory and assemble prompt
      const memoryContentP = memoryReaderP.loadMemory(def.agent_id, def.task);
      const promptContentP = assemblePromptP({
        memory: memoryContentP || undefined,
        skills: skillsContent,
      });

      const agentSkillsP = allAgentConfigs.find((a: any) => a.id === def.agent_id)?.skills || [];
      const skillWarnings = checkSkillCoverage(def.agent_id, agentSkillsP, def.task, process.cwd());
      const taskId = randomUUID().slice(0, 8);
      const entry: any = { id: taskId, agentId: def.agent_id, task: def.task, status: 'running', startedAt: Date.now(), skillWarnings };
      entry.promise = worker.executeTask(def.task, undefined, promptContentP)
        .then(async (result: string) => {
          entry.status = 'completed'; entry.result = result; entry.completedAt = Date.now();

          // Publish gossip to still-running batch siblings
          if (gossipPublisher && batchId) {
            const remaining = Array.from(batchTaskIds)
              .map(tid => tasks.get(tid))
              .filter((t: any) => t && t.status === 'running' && t.agentId !== def.agent_id)
              .map((t: any) => agentConfigsCache.find((ac: any) => ac.id === t.agentId))
              .filter((ac: any) => ac !== undefined);

            if (remaining.length > 0) {
              gossipPublisher.publishGossip({
                batchId,
                completedAgentId: def.agent_id,
                completedResult: result,
                remainingSiblings: remaining,
              }).catch((err: Error) => process.stderr.write(`[gossipcat] Gossip: ${err.message}\n`));
            }
          }
        })
        .catch((err: Error) => { entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now(); });
      tasks.set(taskId, entry);
      batchTaskIds.add(taskId);

      try {
        const { TaskGraph: TaskGraphP } = await import('@gossip/orchestrator');
        const graphP = new TaskGraphP(process.cwd());
        const skills = allAgentConfigs.find((a: any) => a.id === def.agent_id)?.skills || [];
        graphP.recordCreated(taskId, def.agent_id, def.task, skills);
      } catch { /* non-blocking */ }

      taskIds.push(taskId);
    }

    batches.set(batchId, batchTaskIds);

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
      let text: string;
      if (t.status === 'completed') text = `[${t.id}] ${t.agentId} (${dur}):\n${t.result}`;
      else if (t.status === 'failed') text = `[${t.id}] ${t.agentId} (${dur}): ERROR: ${t.error}`;
      else text = `[${t.id}] ${t.agentId}: still running...`;

      // Append skill coverage warnings
      if (t.skillWarnings?.length) {
        text += `\n\n⚠️ Skill coverage gaps:\n${t.skillWarnings.map((w: string) => `  - ${w}`).join('\n')}`;
      }

      return text;
    });

    // Record task completion/failure/cancellation in TaskGraph
    try {
      const { TaskGraph: TaskGraphC } = await import('@gossip/orchestrator');
      const graphC = new TaskGraphC(process.cwd());
      for (const t of targets) {
        const duration = t.completedAt ? t.completedAt - t.startedAt : -1;
        if (t.status === 'completed') {
          graphC.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration);
        } else if (t.status === 'failed') {
          graphC.recordFailed(t.id, t.error || 'Unknown', duration);
        } else if (t.status === 'running') {
          graphC.recordCancelled(t.id, 'collect timeout', duration);
        }
      }
    } catch { /* non-blocking */ }

    // Check for skill suggestions and skeleton generation
    try {
      const { SkillGapTracker } = await import('@gossip/orchestrator');
      const tracker = new SkillGapTracker(process.cwd());

      // Surface suggestions from completed tasks
      for (const t of targets) {
        if (t.status !== 'running') {
          const suggestions = tracker.getSuggestionsSince(t.agentId, t.startedAt);
          if (suggestions.length) {
            // Find the matching result and append
            const idx = targets.indexOf(t);
            if (idx >= 0 && results[idx]) {
              results[idx] += `\n\n💡 Skills suggested by ${t.agentId}:\n` +
                suggestions.map((s: any) => `  - ${s.skill}: ${s.reason}`).join('\n');
            }
          }
        }
      }

      // Check for skeleton generation
      const skeletonMessages = tracker.checkAndGenerate();
      if (skeletonMessages.length) {
        results.push('📝 ' + skeletonMessages.join('\n📝 '));
      }
    } catch { /* orchestrator not available — skip */ }

    // Write agent memories (async, non-blocking)
    try {
      const { MemoryWriter, MemoryCompactor } = await import('@gossip/orchestrator');
      const memWriter = new MemoryWriter(process.cwd());
      const compactor = new MemoryCompactor(process.cwd());

      const { findConfigPath, loadConfig, configToAgentConfigs } = await import('./config');
      const cfgPathM = findConfigPath();
      const allAgentConfigsM = cfgPathM
        ? configToAgentConfigs(loadConfig(cfgPathM))
        : [];

      for (const t of targets) {
        if (t.status === 'completed') {
          const agentSkillsForMemory = allAgentConfigsM.find((a: any) => a.id === t.agentId)?.skills || [];

          await memWriter.writeTaskEntry(t.agentId, {
            taskId: t.id,
            task: t.task,
            skills: agentSkillsForMemory,
            scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
          });
          memWriter.rebuildIndex(t.agentId);

          const result = compactor.compactIfNeeded(t.agentId);
          if (result.message) {
            process.stderr.write(`[gossipcat] ${result.message}\n`);
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[gossipcat] Memory write error: ${(err as Error).message}\n`);
    }

    // Batch cleanup — unsubscribe completed batches
    try {
      for (const [bid, taskIdSet] of batches) {
        const allDone = Array.from(taskIdSet).every(tid => {
          const t = tasks.get(tid);
          return !t || t.status !== 'running';
        });
        if (allDone) {
          for (const tid of taskIdSet) {
            const t = tasks.get(tid);
            if (t) {
              const w = workers.get(t.agentId);
              if (w?.unsubscribeFromBatch) w.unsubscribeFromBatch(bid).catch(() => {});
            }
          }
          batches.delete(bid);
        }
      }
    } catch { /* non-blocking */ }

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

// ── Tool: update agent instructions ──────────────────────────────────────
server.tool(
  'gossip_update_instructions',
  'Update a worker agent\'s instructions for subsequent tasks. Use to adjust behavior based on performance.',
  {
    agent_id: z.string().describe('Agent ID to update'),
    instruction_update: z.string().describe('New instructions content (max 5000 chars)'),
    mode: z.enum(['append', 'replace']).describe('"append" to add to existing, "replace" to overwrite'),
  },
  async ({ agent_id, instruction_update, mode }) => {
    await boot();

    // Validate agent_id format (prevent path traversal)
    if (!/^[a-zA-Z0-9_-]+$/.test(agent_id)) {
      return { content: [{ type: 'text' as const, text: 'Invalid agent ID format.' }] };
    }

    // Size limit
    if (instruction_update.length > 5000) {
      return { content: [{ type: 'text' as const, text: 'Instruction update exceeds 5000 char limit.' }] };
    }

    const worker = workers.get(agent_id);
    if (!worker) {
      return { content: [{ type: 'text' as const, text: `Agent "${agent_id}" not found. Available: ${Array.from(workers.keys()).join(', ')}` }] };
    }

    // Basic content blocklist
    const blocked = ['rm -rf', 'curl ', 'wget ', 'eval(', 'exec('];
    if (blocked.some(b => instruction_update.toLowerCase().includes(b))) {
      return { content: [{ type: 'text' as const, text: 'Instruction update contains blocked content.' }] };
    }

    const { writeFileSync: writeFS } = require('fs');
    const { join: joinPath } = require('path');

    // Backup current instructions before replace
    if (mode === 'replace') {
      const backupPath = joinPath(process.cwd(), '.gossip', 'agents', agent_id, 'instructions-backup.md');
      writeFS(backupPath, worker.getInstructions());
    }

    if (mode === 'replace') {
      worker.setInstructions(instruction_update);
    } else {
      worker.setInstructions(worker.getInstructions() + '\n\n' + instruction_update);
    }

    // Persist to instructions.md
    const instructionsPath = joinPath(process.cwd(), '.gossip', 'agents', agent_id, 'instructions.md');
    writeFS(instructionsPath, worker.getInstructions());

    return { content: [{ type: 'text' as const, text: `Updated instructions for ${agent_id} (${mode}). Takes effect on next task.` }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => { process.stderr.write(`[gossipcat] Fatal: ${err.message}\n`); process.exit(1); });
