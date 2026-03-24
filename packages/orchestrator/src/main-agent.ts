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
import { AgentConfig, DispatchOptions, PlanState, TaskResult, ChatResponse, HandleMessageOptions } from './types';
import { ALL_TOOLS } from '@gossip/tools';
import { ContentBlock, TextContent, MessageType, MessageEnvelope, Message, LLMMessage } from '@gossip/types';
import { GossipAgent } from '@gossip/client';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { DispatchPipeline, ToolServerCallbacks } from './dispatch-pipeline';
import { TaskGraphSync } from './task-graph-sync';
import { ToolRouter, ToolExecutor } from './tool-router';
import { buildToolSystemPrompt, PLAN_CHOICES, PENDING_PLAN_CHOICES } from './tool-definitions';
import { ProjectInitializer } from './project-initializer';
import { TeamManager } from './team-manager';

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
  keyProvider?: (provider: string) => Promise<string | null>;
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
  private toolExecutor: ToolExecutor;
  private projectInitializer: ProjectInitializer;
  private teamManager: TeamManager;
  private keyProviderFn: ((provider: string) => Promise<string | null>) | undefined;
  private conversationHistory: LLMMessage[] = [];
  private readonly MAX_HISTORY = 20; // 10 pairs of user+assistant

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
    this.keyProviderFn = config.keyProvider;
    this.projectInitializer = new ProjectInitializer({
      llm: this.llm,
      projectRoot: this.projectRoot,
      keyProvider: config.keyProvider ?? (async () => null),
    });
    this.teamManager = new TeamManager({
      registry: this.registry,
      pipeline: this.pipeline,
      projectRoot: this.projectRoot,
    });
    this.toolExecutor = new ToolExecutor({
      pipeline: this.pipeline,
      registry: this.registry,
      projectRoot: this.projectRoot,
      dispatcher: this.dispatcher,
      initializer: this.projectInitializer,
      teamManager: this.teamManager,
    });
  }

  /** Start all worker agents (connect to relay) */
  async start(): Promise<void> {
    const { existsSync, readFileSync } = await import('fs');
    const { join } = await import('path');

    for (const config of this.registry.getAll()) {
      if (this.workers.has(config.id)) continue; // skip if already set externally
      // Try apiKeys map first, then keyProvider callback
      let apiKey: string | undefined = this.apiKeys[config.provider];
      if (!apiKey && this.keyProviderFn) {
        apiKey = (await this.keyProviderFn(config.provider)) ?? undefined;
      }
      const llm = createProvider(config.provider, config.model, apiKey);

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

  /** Stop a single worker agent */
  async stopWorker(agentId: string): Promise<void> {
    const worker = this.workers.get(agentId);
    if (worker) {
      await worker.stop();
      this.workers.delete(agentId);
    }
  }

  /** Stop all worker agents */
  async stop(): Promise<void> {
    this.pipeline.flushTaskGraph();
    for (const worker of this.workers.values()) {
      await worker.stop();
    }
    this.workers.clear();
  }

  /** Handle a user message. Default mode is cognitive (tool-calling); 'decompose' preserves the old flow. */
  async handleMessage(userMessage: string | ContentBlock[], options?: HandleMessageOptions): Promise<ChatResponse> {
    if (options?.mode === 'decompose') {
      return this.handleMessageDecompose(userMessage);
    }
    return this.handleMessageCognitive(userMessage);
  }

  /** Original decompose → assign → dispatch → synthesize flow. */
  private async handleMessageDecompose(userMessage: string | ContentBlock[]): Promise<ChatResponse> {
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

  /** Cognitive mode: LLM decides whether to chat or call tools. */
  private async handleMessageCognitive(userMessage: string | ContentBlock[]): Promise<ChatResponse> {
    // Check if project has agents configured
    if (this.registry.getAll().length === 0) {
      const text = typeof userMessage === 'string'
        ? userMessage
        : userMessage.filter(b => b.type === 'text').map(b => (b as any).text).join(' ') || '';

      // If pendingTask exists, this is a modification of a prior proposal
      // Combine original task + modification instruction
      const taskForProposal = this.projectInitializer.pendingTask
        ? `${this.projectInitializer.pendingTask}\n\nModification: ${text}`
        : text;

      const signals = this.projectInitializer.scanDirectory(this.projectRoot);
      // Store the original task (not the modification) for re-processing after accept
      if (!this.projectInitializer.pendingTask) {
        this.projectInitializer.pendingTask = text;
      }
      const proposal = await this.projectInitializer.proposeTeam(taskForProposal, signals);

      return {
        text: proposal.text,
        choices: proposal.choices,
        status: 'done',
      };
    }

    // Extract text for LLM
    const text = typeof userMessage === 'string'
      ? userMessage
      : userMessage.filter(b => b.type === 'text').map(b => (b as TextContent).text).join(' ') || 'Describe this image.';

    // Build system prompt with tool definitions
    const agents = this.registry.getAll();
    const toolPrompt = buildToolSystemPrompt(agents);
    const systemPrompt = [this.bootstrapPrompt, CHAT_SYSTEM_PROMPT, toolPrompt].filter(Boolean).join('\n\n');

    // Call LLM with conversation history
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory,
      { role: 'user', content: userMessage },  // preserve ContentBlock[] for multimodal
    ];
    const response = await this.llm.generate(messages, { temperature: 0 });

    // Parse for tool call — [TOOL_CALL] takes precedence over [CHOICES]
    const toolCall = ToolRouter.parseToolCall(response.text);

    let result: ChatResponse;
    if (toolCall) {
      // Execute tool with auto-chaining
      const toolResult = await this.toolExecutor.execute(toolCall);
      const explanation = ToolRouter.stripToolCallBlocks(response.text);
      result = {
        text: explanation ? `${explanation}\n\n${toolResult.text}` : toolResult.text,
        status: 'done',
        agents: toolResult.agents,
        choices: toolResult.choices,
      };
    } else {
      // Plain chat response — parse for [CHOICES]
      result = this.parseResponse(response.text);
    }

    // Update conversation history (trim to MAX_HISTORY)
    this.conversationHistory.push(
      { role: 'user', content: text },
      { role: 'assistant', content: result.text.slice(0, 2000) }, // cap to prevent context overflow
    );
    if (this.conversationHistory.length > this.MAX_HISTORY) {
      this.conversationHistory = this.conversationHistory.slice(-this.MAX_HISTORY);
    }

    return result;
  }

  /** Handle a user's choice selection — continues the conversation with context */
  async handleChoice(originalMessage: string, choiceValue: string): Promise<ChatResponse> {
    // Project init approval
    if (this.projectInitializer.pendingTask) {
      if (choiceValue === 'accept') {
        await this.projectInitializer.writeConfig(this.projectRoot);
        // Reload agents from new config
        const newAgents: string[] = [];
        if (this.projectInitializer.pendingProposal?.agents) {
          for (const agent of this.projectInitializer.pendingProposal.agents) {
            this.registry.register(agent);
            newAgents.push(agent.id);
          }
        }
        // Start workers if keyProvider available
        let workersStarted = 0;
        if (this.keyProviderFn) {
          try {
            workersStarted = await this.syncWorkers(this.keyProviderFn);
          } catch (err) {
            process.stderr.write(`[MainAgent] Failed to start workers: ${(err as Error).message}\n`);
          }
        }
        const task = this.projectInitializer.pendingTask;
        this.projectInitializer.pendingTask = null;
        this.projectInitializer.pendingProposal = null;

        // Show team confirmation, then proceed with the original task
        const agentList = newAgents.join(', ');
        const teamMsg = `Team ready! ${newAgents.length} agents online (${agentList}).`;
        process.stderr.write(`[gossipcat] ${teamMsg}\n`);

        if (task) {
          // Now proceed with the original task using cognitive mode
          // Agents are registered, workers are started — cognitive mode will work
          const taskResponse = await this.handleMessageCognitive(task);
          return {
            text: `${teamMsg}\n\n${taskResponse.text}`,
            status: taskResponse.status,
            agents: taskResponse.agents,
            choices: taskResponse.choices,
          };
        }

        return { text: teamMsg, status: 'done', agents: newAgents };
      }
      if (choiceValue === 'modify') {
        // Keep pendingTask so next message re-triggers init with modifications
        // pendingProposal cleared so a fresh proposal is generated
        this.projectInitializer.pendingProposal = null;
        return { text: 'Describe what you\'d like to change and I\'ll create a new proposal.', status: 'done' };
      }
      if (choiceValue === 'manual') {
        this.projectInitializer.pendingTask = null;
        this.projectInitializer.pendingProposal = null;
        return { text: 'Run `gossipcat setup` in your terminal to manually configure agents.', status: 'done' };
      }
      if (choiceValue === 'skip') {
        this.projectInitializer.pendingTask = null;
        this.projectInitializer.pendingProposal = null;
        return { text: 'No agents configured. You can chat directly or run /init later.', status: 'done' };
      }
    }

    // Team update approval
    if (this.teamManager.pendingAction) {
      if (choiceValue === 'confirm_add' && this.teamManager.pendingAction.action === 'add') {
        const config = this.teamManager.pendingAction.config as any;
        this.teamManager.applyAdd(config);
        this.teamManager.pendingAction = null;
        if (this.keyProviderFn) {
          await this.syncWorkers(this.keyProviderFn);
        }
        return { text: `Added ${config.id} to your team.`, status: 'done' };
      }
      if (choiceValue === 'confirm_remove' || choiceValue === 'force_remove') {
        const agentId = this.teamManager.pendingAction.agentId!;
        this.teamManager.applyRemove(agentId);
        this.teamManager.pendingAction = null;
        await this.stopWorker(agentId);
        return { text: `Removed ${agentId} from your team.`, status: 'done' };
      }
      if (choiceValue === 'wait_and_remove') {
        // Collect pending tasks first, then remove
        const agentId = this.teamManager.pendingAction.agentId!;
        this.teamManager.pendingAction = null;
        // Best effort: wait briefly then remove
        this.teamManager.applyRemove(agentId);
        await this.stopWorker(agentId);
        return { text: `Waited for tasks and removed ${agentId}.`, status: 'done' };
      }
      if (choiceValue === 'cancel') {
        this.teamManager.pendingAction = null;
        return { text: 'Cancelled.', status: 'done' };
      }
    }

    // Plan approval
    if (this.toolExecutor.pendingPlan) {
      if (choiceValue === PLAN_CHOICES.EXECUTE) {
        const plan = this.toolExecutor.pendingPlan;
        this.toolExecutor.pendingPlan = null;
        const toolResult = await this.toolExecutor.executePlan(plan);
        return { text: toolResult.text, status: 'done', agents: toolResult.agents };
      }
      if (choiceValue === PLAN_CHOICES.CANCEL || choiceValue === PENDING_PLAN_CHOICES.CANCEL) {
        this.toolExecutor.pendingPlan = null;
        return { text: 'Plan cancelled.', status: 'done' };
      }
      if (choiceValue === PENDING_PLAN_CHOICES.DISCARD) {
        this.toolExecutor.pendingPlan = null;
        return { text: 'Old plan discarded. Send your new task.', status: 'done' };
      }
      if (choiceValue === PENDING_PLAN_CHOICES.EXECUTE_PENDING) {
        const plan = this.toolExecutor.pendingPlan;
        this.toolExecutor.pendingPlan = null;
        const toolResult = await this.toolExecutor.executePlan(plan);
        return { text: toolResult.text, status: 'done', agents: toolResult.agents };
      }
      if (choiceValue === PLAN_CHOICES.MODIFY) {
        this.toolExecutor.pendingPlan = null;
        return { text: 'Plan discarded. Describe your modifications and I\'ll create a new plan.', status: 'done' };
      }
    }

    // Instruction update confirmation
    if (this.toolExecutor.pendingInstructionUpdate) {
      if (choiceValue === 'apply') {
        const pending = this.toolExecutor.pendingInstructionUpdate;
        this.toolExecutor.pendingInstructionUpdate = null;
        const toolResult = await this.toolExecutor.applyInstructionUpdate(pending);
        return { text: toolResult.text, status: 'done' };
      }
      this.toolExecutor.pendingInstructionUpdate = null;
      return { text: 'Instruction update cancelled.', status: 'done' };
    }

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
