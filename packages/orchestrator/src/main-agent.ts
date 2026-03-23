/**
 * MainAgent — the developer's single point of contact.
 *
 * Receives natural language tasks, decomposes them via TaskDispatcher,
 * fans out to WorkerAgents, and synthesizes results.
 */

import { ILLMProvider, createProvider } from './llm-client';
import { AgentRegistry } from './agent-registry';
import { TaskDispatcher } from './task-dispatcher';
import { WorkerAgent } from './worker-agent';
import { AgentConfig, DispatchOptions, PlanState, TaskResult, ChatResponse } from './types';
import { ALL_TOOLS } from '@gossip/tools';
import { ContentBlock, TextContent, MessageType, MessageEnvelope, Message } from '@gossip/types';
import { GossipAgent } from '@gossip/client';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { DispatchPipeline, ToolServerCallbacks } from './dispatch-pipeline';
import { TaskGraphSync } from './task-graph-sync';

const CHAT_SYSTEM_PROMPT = `You are a developer assistant powering Gossip Mesh. Be concise and direct.

When you want to present the developer with choices, use this format in your response:

[CHOICES]
message: Your question here?
- option_value | Display Label | Optional hint text
- option_value | Display Label | Optional hint
[/CHOICES]

Examples of when to use choices:
- Multiple approaches to a task (refactor in-place vs extract vs rewrite)
- Confirming a destructive action (delete files, reset branch)
- Selecting which files/modules to work on
- Choosing between trade-offs (speed vs thoroughness)

Only present choices when there's a genuine decision. Don't use them for simple yes/no — just ask directly.
When there's a clear best option, recommend it but still offer alternatives.`;

export interface MainAgentConfig {
  provider: string;
  model: string;
  apiKey?: string;
  relayUrl: string;
  agents: AgentConfig[];
  apiKeys?: Record<string, string>;  // provider → key
  projectRoot?: string;  // defaults to process.cwd()
  llm?: ILLMProvider;  // override for testing
  bootstrapPrompt?: string;  // NEW — injected by BootstrapGenerator
  syncFactory?: () => TaskGraphSync | null;
  toolServer?: ToolServerCallbacks | null;
}

export class MainAgent {
  private llm: ILLMProvider;
  private registry: AgentRegistry;
  private dispatcher: TaskDispatcher;
  private workers: Map<string, WorkerAgent> = new Map();
  private relayUrl: string;
  private apiKeys: Record<string, string>;
  private projectRoot: string;
  private pipeline: DispatchPipeline;
  private bootstrapPrompt: string;
  private orchestratorAgent: GossipAgent | null = null;

  constructor(config: MainAgentConfig) {
    this.llm = config.llm ?? createProvider(config.provider, config.model, config.apiKey);
    this.registry = new AgentRegistry();
    this.dispatcher = new TaskDispatcher(this.llm, this.registry);
    this.relayUrl = config.relayUrl;
    this.apiKeys = config.apiKeys ?? {};
    this.bootstrapPrompt = config.bootstrapPrompt || '';

    for (const agent of config.agents) {
      this.registry.register(agent);
    }

    this.projectRoot = config.projectRoot || process.cwd();
    this.pipeline = new DispatchPipeline({
      projectRoot: this.projectRoot,
      workers: this.workers,
      registryGet: (id) => this.registry.get(id),
      llm: this.llm,
      syncFactory: config.syncFactory,
      toolServer: config.toolServer,
    });
  }

  /** Start all worker agents (connect to relay) */
  async start(): Promise<void> {
    const { existsSync, readFileSync } = await import('fs');
    const { join } = await import('path');

    for (const config of this.registry.getAll()) {
      if (this.workers.has(config.id)) continue; // skip if already set externally
      const llm = createProvider(config.provider, config.model, this.apiKeys[config.provider]);

      // Load per-agent instructions if available
      const instructionsPath = join(this.projectRoot, '.gossip', 'agents', config.id, 'instructions.md');
      const instructions = existsSync(instructionsPath)
        ? readFileSync(instructionsPath, 'utf-8') : undefined;

      const worker = new WorkerAgent(config.id, llm, this.relayUrl, ALL_TOOLS, instructions);
      await worker.start();
      this.workers.set(config.id, worker);
    }

    // Connect orchestrator agent to relay for verify_write review requests
    try {
      this.orchestratorAgent = new GossipAgent({ agentId: 'orchestrator', relayUrl: this.relayUrl, reconnect: true });
      await this.orchestratorAgent.connect();
      this.orchestratorAgent.on('message', this.handleReviewRequest.bind(this));
    } catch (err) {
      console.error(`[MainAgent] Orchestrator relay connection failed: ${(err as Error).message}`);
    }
  }

  /** Set externally-created workers (used by MCP server to avoid duplicate connections) */
  setWorkers(externalWorkers: Map<string, WorkerAgent>): void {
    for (const [id, worker] of externalWorkers) {
      this.workers.set(id, worker);
    }
  }

  dispatch(agentId: string, task: string, options?: DispatchOptions) { return this.pipeline.dispatch(agentId, task, options); }
  async collect(taskIds?: string[], timeoutMs?: number, options?: { consensus?: boolean }) { return this.pipeline.collect(taskIds, timeoutMs, options); }
  async dispatchParallel(tasks: Array<{ agentId: string; task: string; options?: DispatchOptions }>, options?: { consensus?: boolean }) { return this.pipeline.dispatchParallel(tasks, options); }
  registerPlan(plan: PlanState): void { this.pipeline.registerPlan(plan); }
  getWorker(agentId: string) { return this.workers.get(agentId); }
  getTask(taskId: string) { return this.pipeline.getTask(taskId); }
  setGossipPublisher(publisher: any) { this.pipeline.setGossipPublisher(publisher); }
  setOverlapDetector(detector: any): void { this.pipeline.setOverlapDetector(detector); }
  setLensGenerator(generator: any): void { this.pipeline.setLensGenerator(generator); }

  /** Register new agent configs (for hot-reload from config changes) */
  registerAgent(config: AgentConfig): void {
    this.registry.register(config);
  }

  async syncWorkers(keyProvider: (provider: string) => Promise<string | null>): Promise<number> {
    const { existsSync, readFileSync } = await import('fs');
    const { join } = await import('path');

    let added = 0;
    for (const ac of this.registry.getAll()) {
      if (this.workers.has(ac.id)) continue;
      const key = await keyProvider(ac.provider);
      const llm = createProvider(ac.provider, ac.model, key ?? undefined);

      const instructionsPath = join(this.projectRoot, '.gossip', 'agents', ac.id, 'instructions.md');
      const instructions = existsSync(instructionsPath)
        ? readFileSync(instructionsPath, 'utf-8') : undefined;

      const worker = new WorkerAgent(ac.id, llm, this.relayUrl, ALL_TOOLS, instructions);
      await worker.start();
      this.workers.set(ac.id, worker);
      added++;
    }
    return added;
  }

  /** Stop all worker agents */
  async stop(): Promise<void> {
    this.pipeline.flushTaskGraph();
    for (const worker of this.workers.values()) {
      await worker.stop();
    }
    this.workers.clear();
  }

  /** Handle a user message: decompose, dispatch, synthesize. Returns structured ChatResponse. */
  async handleMessage(userMessage: string | ContentBlock[]): Promise<ChatResponse> {
    // Extract text for task decomposition (dispatcher needs text only)
    const textForDispatch = typeof userMessage === 'string'
      ? userMessage
      : userMessage.filter(b => b.type === 'text').map(b => (b as TextContent).text).join(' ') || 'Describe this image.';

    const plan = await this.dispatcher.decompose(textForDispatch);
    this.dispatcher.assignAgents(plan);

    // Handle unassigned tasks directly with main LLM
    const unassigned = plan.subTasks.filter(st => !st.assignedAgent);
    if (unassigned.length === plan.subTasks.length) {
      const systemPrompt = this.bootstrapPrompt
        ? this.bootstrapPrompt + '\n\n' + CHAT_SYSTEM_PROMPT
        : CHAT_SYSTEM_PROMPT;
      const response = await this.llm.generate([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ]);
      return this.parseResponse(response.text);
    }

    // Execute assigned sub-tasks
    const results: TaskResult[] = [];
    const assigned = plan.subTasks.filter(st => st.assignedAgent);

    if (plan.strategy === 'parallel') {
      const promises = assigned.map(subTask => this.executeSubTask(subTask));
      results.push(...await Promise.all(promises));
    } else {
      for (const subTask of assigned) {
        results.push(await this.executeSubTask(subTask));
      }
    }

    const text = await this.synthesize(textForDispatch, results);
    return {
      text,
      status: 'done',
      agents: results.map(r => r.agentId),
    };
  }

  /** Handle a user's choice selection — continues the conversation with context */
  async handleChoice(originalMessage: string, choiceValue: string): Promise<ChatResponse> {
    const systemPrompt = this.bootstrapPrompt
      ? this.bootstrapPrompt + '\n\n' + CHAT_SYSTEM_PROMPT
      : CHAT_SYSTEM_PROMPT;
    const response = await this.llm.generate([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: originalMessage },
      { role: 'assistant', content: `I presented options and the developer chose: "${choiceValue}". Proceeding with that approach.` },
      { role: 'user', content: `Yes, go with "${choiceValue}".` },
    ]);
    return this.parseResponse(response.text);
  }

  /**
   * Parse LLM response for structured elements.
   * Detects choice blocks in the format:
   *   [CHOICES]
   *   message: How should I proceed?
   *   - option_value | Display Label | Optional hint
   *   - option_value | Display Label
   *   [/CHOICES]
   */
  private parseResponse(text: string): ChatResponse {
    const choiceMatch = text.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/);
    if (!choiceMatch) {
      return { text, status: 'done' };
    }

    const choiceBlock = choiceMatch[1].trim();
    const lines = choiceBlock.split('\n').map(l => l.trim()).filter(Boolean);
    const messageLine = lines.find(l => l.startsWith('message:'));
    const optionLines = lines.filter(l => l.startsWith('- '));

    const message = messageLine?.replace('message:', '').trim() || 'How should I proceed?';
    const options = optionLines.map(line => {
      const parts = line.slice(2).split('|').map(p => p.trim());
      return {
        value: parts[0],
        label: parts[1] || parts[0],
        hint: parts[2],
      };
    });

    const textBefore = text.slice(0, text.indexOf('[CHOICES]')).trim();
    const textAfter = text.slice(text.indexOf('[/CHOICES]') + '[/CHOICES]'.length).trim();
    const cleanText = [textBefore, textAfter].filter(Boolean).join('\n\n');

    return {
      text: cleanText,
      choices: options.length > 0 ? { message, options, allowCustom: true, type: 'select' } : undefined,
      status: 'done',
    };
  }

  private async handleReviewRequest(data: unknown, envelope: MessageEnvelope): Promise<void> {
    if (envelope.t !== MessageType.RPC_REQUEST) return;

    const payload = data as Record<string, unknown>;
    if (payload?.tool !== 'review_request') return;

    const rawArgs = payload.args as Record<string, unknown> | undefined;
    if (!rawArgs || typeof rawArgs.callerId !== 'string' || typeof rawArgs.diff !== 'string' || typeof rawArgs.testResult !== 'string') {
      console.error('[MainAgent] Malformed review_request payload — missing or invalid args');
      return;
    }
    const args = rawArgs as { callerId: string; diff: string; testResult: string };
    let reviewText = 'No reviewer available — tests-only verification.';

    try {
      // Find best reviewer, excluding the calling agent
      const reviewer = this.registry.getAll()
        .filter(a => a.id !== args.callerId && a.skills.includes('code_review'))
        .find(a => this.workers.has(a.id));

      if (reviewer) {
        const { promise } = this.pipeline.dispatch(reviewer.id,
          `Review this diff for correctness:\n\n${args.diff}\n\nTest results:\n${args.testResult}\n\nProvide a brief review: what's good, what needs fixing.`
        );
        try {
          reviewText = await promise;
        } catch { reviewText = 'Reviewer agent failed.'; }
      }
    } catch (err) {
      reviewText = `Review error: ${(err as Error).message}`;
    }

    // Send RPC response back to ToolServer
    try {
      const body = Buffer.from(msgpackEncode({ result: reviewText })) as unknown as Uint8Array;
      const correlationId = (envelope.rid_req || envelope.id) as string;
      const response = Message.createRpcResponse('orchestrator', envelope.sid, correlationId, body);
      await this.orchestratorAgent!.sendEnvelope(response.toEnvelope());
    } catch (err) {
      console.error(`[MainAgent] Failed to send review response: ${(err as Error).message}`);
    }
  }

  private async executeSubTask(subTask: { assignedAgent?: string; description: string }): Promise<TaskResult> {
    const { taskId, promise } = this.pipeline.dispatch(subTask.assignedAgent!, subTask.description);
    const start = Date.now();
    try {
      const result = await promise;
      await this.pipeline.writeMemoryForTask(taskId);
      return { agentId: subTask.assignedAgent!, task: subTask.description, result, duration: Date.now() - start };
    } catch (err) {
      return {
        agentId: subTask.assignedAgent!, task: subTask.description,
        result: '', error: (err as Error).message, duration: Date.now() - start,
      };
    }
  }

  private async synthesize(originalTask: string, results: TaskResult[]): Promise<string> {
    if (results.length === 1) {
      return results[0].error || results[0].result;
    }

    const summaryPrompt = results.map(r =>
      `Agent ${r.agentId} (${r.duration}ms):\n${r.error ? `ERROR: ${r.error}` : r.result}`
    ).join('\n\n---\n\n');

    const response = await this.llm.generate([
      { role: 'system', content: 'Synthesize the following agent results into a single coherent response. Be concise.' },
      { role: 'user', content: `Original task: ${originalTask}\n\nAgent results:\n${summaryPrompt}` },
    ]);

    return response.text;
  }
}
