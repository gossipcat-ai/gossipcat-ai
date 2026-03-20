#!/usr/bin/env node
/**
 * Gossipcat MCP Server — exposes orchestration tools to any IDE.
 *
 * Two tiers:
 * - High-level: gossip_orchestrate (includes MainAgent LLM, full auto)
 * - Low-level: gossip_dispatch / gossip_dispatch_parallel / gossip_collect
 *   (no orchestrator LLM — the IDE is the brain)
 */
import { RelayServer } from '@gossip/relay';
import { ToolServer, ALL_TOOLS } from '@gossip/tools';
import { MainAgent, WorkerAgent, createProvider } from '@gossip/orchestrator';
// MainAgentConfig used implicitly in boot()
import { findConfigPath, loadConfig, configToAgentConfigs } from './config';
import { Keychain } from './keychain';
import { randomUUID } from 'crypto';

// ── MCP Protocol Types ──────────────────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Task tracking for dispatch/collect ───────────────────────────────────────
interface DispatchedTask {
  id: string;
  agentId: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  promise: Promise<void>;
}

// ── Tool Definitions ────────────────────────────────────────────────────────
const MCP_TOOLS = [
  // ── High-level (includes orchestrator LLM) ──────────────────────────────
  {
    name: 'gossip_orchestrate',
    description: 'HIGH-LEVEL: Submit a task to the Gossip Mesh orchestrator. It decomposes the task, assigns sub-tasks to agents, and returns the synthesized result. Use when you want gossipcat to handle everything automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to execute.' },
      },
      required: ['task'],
    },
  },
  // ── Low-level (IDE is the orchestrator) ─────────────────────────────────
  {
    name: 'gossip_dispatch',
    description: 'LOW-LEVEL: Send a task directly to a specific agent by ID. Returns a task ID for collecting results later. The IDE controls decomposition and assignment — gossipcat just executes. Use gossip_agents first to see available agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to dispatch to (e.g. "local-reviewer", "gpt-implementer")' },
        task: { type: 'string', description: 'The task for this agent to execute.' },
        context: { type: 'string', description: 'Optional context (e.g. file contents, prior results from other agents).' },
      },
      required: ['agent_id', 'task'],
    },
  },
  {
    name: 'gossip_dispatch_parallel',
    description: 'LOW-LEVEL: Fan out multiple tasks to multiple agents simultaneously. Returns task IDs for each. Use when you want several agents working in parallel (e.g. security review + performance review).',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Array of { agent_id, task, context? } objects to dispatch.',
          items: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', description: 'Agent ID' },
              task: { type: 'string', description: 'Task for this agent' },
              context: { type: 'string', description: 'Optional context' },
            },
            required: ['agent_id', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'gossip_collect',
    description: 'LOW-LEVEL: Collect results from dispatched tasks. Can wait for specific tasks or all pending tasks. Returns results for completed tasks and status for still-running ones.',
    inputSchema: {
      type: 'object',
      properties: {
        task_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs to collect. Omit to collect all pending tasks.',
        },
        wait: {
          type: 'boolean',
          description: 'If true, wait for tasks to complete (up to timeout). Default: true.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Max time to wait in milliseconds. Default: 120000 (2 min).',
        },
      },
    },
  },
  // ── Info tools ──────────────────────────────────────────────────────────
  {
    name: 'gossip_agents',
    description: 'List all configured agents with their provider, model, role, and skills. Use before gossip_dispatch to know what agents are available.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'gossip_status',
    description: 'Check Gossip Mesh status: relay, tool server, connected agents, pending tasks.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ── MCP Server ──────────────────────────────────────────────────────────────
class GossipMcpServer {
  private relay: RelayServer | null = null;
  private toolServer: ToolServer | null = null;
  private mainAgent: MainAgent | null = null;
  private workers: Map<string, WorkerAgent> = new Map();
  private tasks: Map<string, DispatchedTask> = new Map();
  private initialized = false;
  private keychain = new Keychain();

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.respond(request.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'gossipcat', version: '0.1.0' },
          });
        case 'notifications/initialized':
          return null;
        case 'tools/list':
          return this.respond(request.id, { tools: MCP_TOOLS });
        case 'tools/call':
          return await this.handleToolCall(request);
        default:
          return this.respondError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (err) {
      return this.respondError(request.id, -32603, (err as Error).message);
    }
  }

  private async handleToolCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const name = params?.name;
    const args = params?.arguments || {};

    // Boot on first tool call that needs infrastructure
    if (!this.initialized && name !== 'gossip_agents') {
      await this.boot();
    }

    switch (name) {
      case 'gossip_orchestrate':
        return this.handleOrchestrate(request.id, args);
      case 'gossip_dispatch':
        return this.handleDispatch(request.id, args);
      case 'gossip_dispatch_parallel':
        return this.handleDispatchParallel(request.id, args);
      case 'gossip_collect':
        return this.handleCollect(request.id, args);
      case 'gossip_agents':
        return this.handleAgents(request.id);
      case 'gossip_status':
        return this.handleStatus(request.id);
      default:
        return this.respondError(request.id, -32602, `Unknown tool: ${String(name)}`);
    }
  }

  // ── High-level: full orchestration ──────────────────────────────────────
  private async handleOrchestrate(id: number | string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (!this.mainAgent) {
      return this.text(id, 'Error: MainAgent not initialized. Is gossip.agents.json configured?');
    }
    try {
      const response = await this.mainAgent.handleMessage(args.task as string);
      const suffix = response.agents?.length ? `\n\n[Agents: ${response.agents.join(', ')}]` : '';
      return this.text(id, response.text + suffix);
    } catch (err) {
      return this.text(id, `Orchestration error: ${(err as Error).message}`);
    }
  }

  // ── Low-level: dispatch to specific agent ───────────────────────────────
  private async handleDispatch(id: number | string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    const agentId = args.agent_id as string;
    const task = args.task as string;
    const context = args.context as string | undefined;

    const worker = this.workers.get(agentId);
    if (!worker) {
      const available = Array.from(this.workers.keys()).join(', ');
      return this.text(id, `Agent "${agentId}" not found. Available: ${available}`);
    }

    const taskId = randomUUID().slice(0, 8);
    const dispatched: DispatchedTask = {
      id: taskId,
      agentId,
      task,
      status: 'running',
      startedAt: Date.now(),
      promise: null as any, // set below
    };

    dispatched.promise = worker.executeTask(task, context)
      .then(result => {
        dispatched.status = 'completed';
        dispatched.result = result;
        dispatched.completedAt = Date.now();
      })
      .catch(err => {
        dispatched.status = 'failed';
        dispatched.error = (err as Error).message;
        dispatched.completedAt = Date.now();
      });

    this.tasks.set(taskId, dispatched);
    return this.text(id, `Dispatched to ${agentId}. Task ID: ${taskId}`);
  }

  // ── Low-level: parallel dispatch ────────────────────────────────────────
  private async handleDispatchParallel(id: number | string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    const taskDefs = args.tasks as Array<{ agent_id: string; task: string; context?: string }>;
    if (!taskDefs?.length) {
      return this.text(id, 'No tasks provided.');
    }

    const taskIds: string[] = [];
    const errors: string[] = [];

    for (const def of taskDefs) {
      const worker = this.workers.get(def.agent_id);
      if (!worker) {
        errors.push(`Agent "${def.agent_id}" not found`);
        continue;
      }

      const taskId = randomUUID().slice(0, 8);
      const dispatched: DispatchedTask = {
        id: taskId,
        agentId: def.agent_id,
        task: def.task,
        status: 'running',
        startedAt: Date.now(),
        promise: null as any,
      };

      dispatched.promise = worker.executeTask(def.task, def.context)
        .then(result => {
          dispatched.status = 'completed';
          dispatched.result = result;
          dispatched.completedAt = Date.now();
        })
        .catch(err => {
          dispatched.status = 'failed';
          dispatched.error = (err as Error).message;
          dispatched.completedAt = Date.now();
        });

      this.tasks.set(taskId, dispatched);
      taskIds.push(taskId);
    }

    let msg = `Dispatched ${taskIds.length} tasks:\n${taskIds.map((tid, i) => `  ${tid} → ${taskDefs[i].agent_id}`).join('\n')}`;
    if (errors.length) msg += `\n\nErrors:\n${errors.join('\n')}`;
    return this.text(id, msg);
  }

  // ── Low-level: collect results ──────────────────────────────────────────
  private async handleCollect(id: number | string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    const taskIds = args.task_ids as string[] | undefined;
    const wait = args.wait !== false; // default true
    const timeoutMs = (args.timeout_ms as number) || 120_000;

    const targets = taskIds
      ? taskIds.map(tid => this.tasks.get(tid)).filter(Boolean) as DispatchedTask[]
      : Array.from(this.tasks.values()).filter(t => t.status === 'running');

    if (targets.length === 0) {
      return this.text(id, taskIds ? 'No matching tasks found.' : 'No pending tasks.');
    }

    if (wait) {
      await Promise.race([
        Promise.all(targets.map(t => t.promise)),
        new Promise(r => setTimeout(r, timeoutMs)),
      ]);
    }

    const results = targets.map(t => {
      const duration = t.completedAt ? `${t.completedAt - t.startedAt}ms` : 'still running';
      if (t.status === 'completed') {
        return `[${t.id}] ${t.agentId} (${duration}):\n${t.result}`;
      } else if (t.status === 'failed') {
        return `[${t.id}] ${t.agentId} (${duration}): ERROR: ${t.error}`;
      } else {
        return `[${t.id}] ${t.agentId}: still running...`;
      }
    });

    // Clean up completed tasks
    for (const t of targets) {
      if (t.status !== 'running') this.tasks.delete(t.id);
    }

    return this.text(id, results.join('\n\n---\n\n'));
  }

  // ── Info: list agents ───────────────────────────────────────────────────
  private handleAgents(id: number | string): JsonRpcResponse {
    const configPath = findConfigPath();
    if (!configPath) {
      return this.text(id, 'No gossip.agents.json found. Run gossipcat setup first.');
    }
    const config = loadConfig(configPath);
    const agents = configToAgentConfigs(config);
    const list = agents.map(a =>
      `- ${a.id}: ${a.provider}/${a.model} (${a.preset || 'custom'}) — skills: ${a.skills.join(', ')}`
    ).join('\n');
    return this.text(id, `Orchestrator: ${config.main_agent.model} (${config.main_agent.provider})\n\nAgents:\n${list}`);
  }

  // ── Info: system status ─────────────────────────────────────────────────
  private handleStatus(id: number | string): JsonRpcResponse {
    const pendingTasks = Array.from(this.tasks.values()).filter(t => t.status === 'running');
    return this.text(id, [
      'Gossip Mesh Status:',
      `  Relay: ${this.relay ? `running :${this.relay.port}` : 'not started'}`,
      `  Tool Server: ${this.toolServer ? 'running' : 'not started'}`,
      `  Workers: ${this.workers.size} connected (${Array.from(this.workers.keys()).join(', ') || 'none'})`,
      `  Orchestrator: ${this.mainAgent ? 'ready' : 'not initialized'}`,
      `  Pending tasks: ${pendingTasks.length}`,
      pendingTasks.length > 0
        ? pendingTasks.map(t => `    ${t.id} → ${t.agentId}: ${t.task.slice(0, 60)}...`).join('\n')
        : '',
    ].filter(Boolean).join('\n'));
  }

  // ── Boot infrastructure ─────────────────────────────────────────────────
  private async boot(): Promise<void> {
    const configPath = findConfigPath();
    if (!configPath) throw new Error('No gossip.agents.json found. Run gossipcat setup first.');

    const config = loadConfig(configPath);
    const agentConfigs = configToAgentConfigs(config);

    // Start relay
    this.relay = new RelayServer({ port: 0 });
    await this.relay.start();

    // Start tool server
    this.toolServer = new ToolServer({ relayUrl: this.relay.url, projectRoot: process.cwd() });
    await this.toolServer.start();

    // Start workers (direct, no MainAgent needed for dispatch mode)
    for (const ac of agentConfigs) {
      const key = await this.keychain.getKey(ac.provider);
      const llm = createProvider(ac.provider, ac.model, key ?? undefined);
      const worker = new WorkerAgent(ac.id, llm, this.relay.url, ALL_TOOLS);
      await worker.start();
      this.workers.set(ac.id, worker);
    }

    // Also start MainAgent for gossip_orchestrate (high-level path)
    const mainKey = await this.keychain.getKey(config.main_agent.provider);
    this.mainAgent = new MainAgent({
      provider: config.main_agent.provider,
      model: config.main_agent.model,
      apiKey: mainKey ?? undefined,
      relayUrl: this.relay.url,
      agents: agentConfigs,
    });
    await this.mainAgent.start();

    this.initialized = true;
    process.stderr.write(`[gossipcat-mcp] Booted: relay :${this.relay.port}, ${this.workers.size} workers\n`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  private text(id: number | string, text: string): JsonRpcResponse {
    return this.respond(id, { content: [{ type: 'text', text }] });
  }
  private respond(id: number | string, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }
  private respondError(id: number | string, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
  async shutdown(): Promise<void> {
    if (this.mainAgent) await this.mainAgent.stop();
    for (const w of this.workers.values()) await w.stop();
    if (this.toolServer) await this.toolServer.stop();
    if (this.relay) await this.relay.stop();
  }
}

// ── stdio transport ─────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const server = new GossipMcpServer();
  let buffer = '';

  process.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (line) handleLine(server, line);
        continue;
      }
      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length: (\d+)/);
      if (!match) break;
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;
      const body = buffer.slice(bodyStart, bodyStart + len);
      buffer = buffer.slice(bodyStart + len);
      handleLine(server, body);
    }
  });

  process.on('SIGINT', async () => { await server.shutdown(); process.exit(0); });
  process.on('SIGTERM', async () => { await server.shutdown(); process.exit(0); });
  process.stdin.resume();
}

async function handleLine(server: GossipMcpServer, line: string): Promise<void> {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    if (request.id === undefined || request.id === null) {
      await server.handleRequest({ ...request, id: 0 });
      return;
    }
    const response = await server.handleRequest(request);
    if (!response) return;
    const str = JSON.stringify(response);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(str)}\r\n\r\n${str}`);
  } catch (err) {
    process.stderr.write(`[gossipcat-mcp] Error: ${(err as Error).message}\n`);
  }
}

main().catch(err => { process.stderr.write(`[gossipcat-mcp] Fatal: ${err.message}\n`); process.exit(1); });
