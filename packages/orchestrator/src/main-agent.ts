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
import { AgentConfig, DispatchOptions, PlanState, TaskResult, ChatResponse, HandleMessageOptions, TaskProgressEvent } from './types';
import { ALL_TOOLS } from '@gossip/tools';
import { ContentBlock, TextContent, MessageType, MessageEnvelope, Message, LLMMessage } from '@gossip/types';
import { GossipAgent } from '@gossip/client';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { DispatchPipeline, ToolServerCallbacks } from './dispatch-pipeline';
import { TaskGraphSync } from './task-graph-sync';
import { ToolRouter, ToolExecutor } from './tool-router';
import { buildToolSystemPrompt, getOrchestratorToolDefinitions, PLAN_CHOICES, PENDING_PLAN_CHOICES } from './tool-definitions';
import { ProjectInitializer } from './project-initializer';
import { TeamManager } from './team-manager';

const CHAT_SYSTEM_PROMPT = `You are the **orchestrator** of Gossip Mesh — a multi-agent system.

## RULES
1. NEVER output raw code — your agents write files.
2. NEVER claim you dispatched unless you emitted a [TOOL_CALL] block.
3. When user approves, IMMEDIATELY use the plan tool — do NOT write your own plan as text.
4. NEVER describe file names, components, or architecture in your messages. That's the agent's job.
5. Respect the user's tech choice exactly. If they chose "Svelte + PixiJS", use that — don't switch to something else.

## Workflow
- **New project/feature** → brainstorm creative direction → suggest tech stack → use plan tool → dispatch
- **Bug fix / quick edit** → use plan tool → dispatch (skip brainstorm)
- **Question** → answer directly (no dispatch)

When ready to build, ALWAYS use the plan tool. Do NOT write numbered implementation steps yourself.

## Brainstorming
For new projects, brainstorm in TWO rounds:
1. **Creative direction** — 2-3 approaches as [CHOICES]. Focus on what makes it special.
2. **Tech stack** — After user picks direction, suggest 2-3 tech approaches as [CHOICES]. Include build tooling, relevant libraries, and language. Let the user decide — don't assume.

## Choices Format
[CHOICES]
message: Your question?
- value | Label | Hint
[/CHOICES]

## Agent Roles
- **implementer** → write code, build features
- **reviewer** → code review, security audit (use dispatch_consensus)
- **researcher** → investigation, API research
- **tester** → testing, debugging

## Write Modes
- sequential (safe default), scoped (parallel by directory), worktree (git branch isolation)`;


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
  private currentProvider: string;
  private currentModel: string;
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
  private lastAcceptedTask: string | null = null;
  private readonly MAX_HISTORY = 20; // 10 pairs of user+assistant

  constructor(config: MainAgentConfig) {
    this.llm = config.llm ?? createProvider(config.provider, config.model, config.apiKey);
    this.currentProvider = config.provider;
    this.currentModel = config.model;
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
      llm: this.llm,
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

  /** Health check for active tasks — diagnostics for "is it working?" */
  getActiveTasksHealth() { return this.pipeline.getActiveTasksHealth(); }

  /** Convenience: number of registered agents */
  getAgentCount(): number { return this.registry.getAll().length; }
  /** Convenience: whether any agents are registered */
  hasAgents(): boolean { return this.registry.getAll().length > 0; }
  /** Convenience: list all registered agent configs */
  getAgentList(): AgentConfig[] { return this.registry.getAll(); }

  /** Set a progress callback for plan execution */
  onTaskProgress(cb: (event: TaskProgressEvent) => void): void {
    this.toolExecutor.onTaskProgress = cb;
  }

  /** Get current orchestrator model info */
  getModel(): { provider: string; model: string } {
    return { provider: this.currentProvider, model: this.currentModel };
  }

  /** Switch orchestrator model at runtime */
  async setModel(provider: string, model: string, apiKey?: string): Promise<void> {
    const key = apiKey || (this.keyProviderFn ? await this.keyProviderFn(provider) : undefined);
    this.llm = createProvider(provider, model, key ?? undefined);
    this.currentProvider = provider;
    this.currentModel = model;
    // Clear conversation history since model context may differ
    this.conversationHistory = [];
  }

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
    const hasAgents = this.registry.getAll().length > 0;

    // Extract text for LLM
    const text = typeof userMessage === 'string'
      ? userMessage
      : userMessage.filter(b => b.type === 'text').map(b => (b as TextContent).text).join(' ') || 'Describe this image.';

    // Build system prompt — with or without tool definitions depending on agent availability
    const agents = this.registry.getAll();
    const toolPrompt = hasAgents ? buildToolSystemPrompt(agents) : '';
    const systemPrompt = [this.bootstrapPrompt, CHAT_SYSTEM_PROMPT, toolPrompt].filter(Boolean).join('\n\n');

    // Call LLM with conversation history
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory,
      { role: 'user', content: userMessage },  // preserve ContentBlock[] for multimodal
    ];
    // Pass orchestrator tools for native function calling when agents are available.
    // This makes the LLM return structured tool calls instead of text-based [TOOL_CALL] blocks.
    const orchestratorTools = hasAgents ? getOrchestratorToolDefinitions() : undefined;
    const response = await this.llm.generate(messages, {
      temperature: 0,
      ...(orchestratorTools ? { tools: orchestratorTools } : {}),
    });

    // Check for tool calls — native (Gemini/OpenAI function calling) OR text-based [TOOL_CALL]
    let toolCall = ToolRouter.parseToolCall(response.text);

    // Native tool calls from providers that support function calling (Gemini, OpenAI)
    if (!toolCall && response.toolCalls?.length) {
      const native = response.toolCalls[0];
      // Normalize: strip gossip_ prefix if present
      let toolName = native.name;
      if (toolName.startsWith('gossip_')) {
        toolName = toolName.replace(/^gossip_/, '');
      }
      toolCall = { tool: toolName, args: native.arguments };
    }

    // If the response contains [TOOL_CALL] but parsing failed, the LLM produced
    // malformed tool call syntax. Retry once with a correction prompt.
    if (!toolCall && response.text.includes('[TOOL_CALL]')) {
      const retryMessages: LLMMessage[] = [
        ...messages,
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'Your previous response contained a [TOOL_CALL] block that could not be parsed. Please re-emit the tool call in valid JSON format:\n[TOOL_CALL]\n{"tool": "tool_name", "args": {"key": "value"}}\n[/TOOL_CALL]' },
      ];
      try {
        const retry = await this.llm.generate(retryMessages, hasAgents ? { temperature: 0 } : undefined);
        toolCall = ToolRouter.parseToolCall(retry.text);
        if (!toolCall && retry.toolCalls?.length) {
          const native = retry.toolCalls[0];
          let toolName = native.name;
          if (toolName.startsWith('gossip_')) toolName = toolName.replace(/^gossip_/, '');
          toolCall = { tool: toolName, args: native.arguments };
        }
      } catch { /* retry failed — proceed without tool call */ }
    }

    // If the LLM wants to use tools but no agents exist yet, trigger team proposal.
    // This happens naturally after brainstorming: the user describes a project,
    // the orchestrator brainstorms ideas, and when it's ready to act (plan/dispatch),
    // it discovers it needs agents. The full conversation context — including the
    // refined idea from brainstorming — feeds into a better team proposal.
    //
    // Guard: require at least 1 prior exchange (2 history entries) before proposing team.
    // This ensures the LLM brainstorms at least once rather than jumping straight to
    // team proposal on the first message.
    if (toolCall && !hasAgents && this.conversationHistory.length >= 2) {
      // Extract the original project description from the first user message in history,
      // not the current text which may be a choice passthrough like 'I chose: "X". Proceed.'
      const firstUserMsg = this.conversationHistory.find(m => m.role === 'user');
      const projectDescription = firstUserMsg && typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : text;

      // Build context summary for the LLM (not shown to user)
      const conversationSummary = this.conversationHistory
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 300) : '[media]'}`)
        .join('\n');

      const signals = this.projectInitializer.scanDirectory(this.projectRoot);
      this.projectInitializer.pendingTask = projectDescription;
      // Pass the project description as the user message (shown in proposal prompt)
      // and the brainstorming context as additional signals (not echoed to user)
      const enrichedSignals = {
        ...signals,
        brainstormContext: conversationSummary,
      };
      const proposal = await this.projectInitializer.proposeTeam(projectDescription, enrichedSignals);

      // Record in history
      this.conversationHistory.push(
        { role: 'user', content: text },
        { role: 'assistant', content: proposal.text.slice(0, 1500) },
      );

      // Only show the proposal to the user — don't include the LLM's brainstorming text
      // or internal context summaries
      return {
        text: proposal.text,
        choices: proposal.choices,
        status: 'done',
      };
    }

    // No agents and no tool call (or tool call too early) — pure brainstorming chat
    // The LLM is still exploring the idea before trying to act
    if (toolCall && !hasAgents && this.conversationHistory.length < 2) {
      // LLM tried to act on the first message — strip tool call, return as brainstorming
      toolCall = null;
    }
    if (!hasAgents && !toolCall) {
      const result = this.parseResponse(response.text);
      this.conversationHistory.push(
        { role: 'user', content: text },
        { role: 'assistant', content: result.text.slice(0, 2000) },
      );
      if (this.conversationHistory.length > this.MAX_HISTORY) {
        this.conversationHistory = this.conversationHistory.slice(-this.MAX_HISTORY);
      }
      return result;
    }

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
      // Detect hallucinated dispatches — LLM claims it dispatched but didn't emit a tool call.
      // Common pattern: "I'm dispatching..." or "I've dispatched..." without [TOOL_CALL].
      const claimsDispatch = /(?:dispatching|dispatched|dispatch.*(?:now|immediately|right away)|sending.*(?:to|the) (?:agent|team))/i.test(response.text);
      if (claimsDispatch && hasAgents) {
        // Force a retry — tell the LLM to actually emit the tool call
        try {
          const retryMessages: LLMMessage[] = [
            ...messages,
            { role: 'assistant', content: response.text },
            { role: 'user', content: 'You said you would dispatch but did NOT emit a [TOOL_CALL]. You MUST emit an actual tool call to dispatch work. Emit the [TOOL_CALL] now.' },
          ];
          const retry = await this.llm.generate(retryMessages, { temperature: 0 });
          let retryToolCall = ToolRouter.parseToolCall(retry.text);
          if (!retryToolCall && retry.toolCalls?.length) {
            const native = retry.toolCalls[0];
            let toolName = native.name;
            if (toolName.startsWith('gossip_')) toolName = toolName.replace(/^gossip_/, '');
            retryToolCall = { tool: toolName, args: native.arguments };
          }
          if (retryToolCall) {
            const toolResult = await this.toolExecutor.execute(retryToolCall);
            const explanation = ToolRouter.stripToolCallBlocks(response.text);
            result = {
              text: explanation ? `${explanation}\n\n${toolResult.text}` : toolResult.text,
              status: 'done',
              agents: toolResult.agents,
              choices: toolResult.choices,
            };
          } else {
            result = this.parseResponse(response.text);
          }
        } catch {
          result = this.parseResponse(response.text);
        }
      } else {
        // Plain chat response — parse for [CHOICES]
        result = this.parseResponse(response.text);
      }
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
  async handleChoice(_originalMessage: string, choiceValue: string): Promise<ChatResponse> {
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
        if (this.keyProviderFn) {
          try {
            await this.syncWorkers(this.keyProviderFn);
          } catch (err) {
            process.stderr.write(`[MainAgent] Failed to start workers: ${(err as Error).message}\n`);
          }
        }
        const task = this.projectInitializer.pendingTask;
        this.lastAcceptedTask = task; // preserve for 'start' handler
        this.projectInitializer.pendingTask = null;
        this.projectInitializer.pendingProposal = null;

        // Show team confirmation with option to start working
        const agentList = newAgents.join(', ');
        const taskHint = task ? `\nReady to start working on: "${task}"` : '';
        const confirmText = `Team ready! ${newAgents.length} agents online (${agentList}).${taskHint}`;

        // Record the accept exchange in history
        this.conversationHistory.push(
          { role: 'user', content: 'I accept this team configuration.' },
          { role: 'assistant', content: confirmText },
        );

        return {
          text: confirmText,
          status: 'done',
          agents: newAgents,
          choices: task ? {
            message: 'Start building?',
            options: [
              { value: 'start', label: `Start: ${task.slice(0, 60)}${task.length > 60 ? '...' : ''}` },
              { value: 'different', label: 'Do something else first' },
            ],
          } : undefined,
        };
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

    // Post-accept choices — these fire AFTER pendingTask is cleared
    if (choiceValue === 'start') {
      const task = this.lastAcceptedTask || 'the project we discussed';
      this.lastAcceptedTask = null;
      return this.handleMessageCognitive(
        `The team is ready. Based on our earlier brainstorming, create a plan for: "${task}". Use the plan tool to decompose this into agent tasks.`,
      );
    }
    if (choiceValue === 'different') {
      this.lastAcceptedTask = null;
      return { text: 'What would you like to do?', status: 'done' };
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

    // Unhandled choice — pass through to cognitive mode with full conversation history.
    // Inject the choice as a user message so the LLM knows what was selected.
    return this.handleMessageCognitive(`I chose: "${choiceValue}". Proceed with that.`);
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
    // Try with closing tag first, then fallback to unclosed (to end of text)
    let choiceMatch = text.match(/\[CHOICES\]([\s\S]*?)\[\/CHOICES\]/);
    let hasClosingTag = true;
    if (!choiceMatch) {
      choiceMatch = text.match(/\[CHOICES\]([\s\S]*)$/);
      hasClosingTag = false;
    }
    if (!choiceMatch) {
      return { text, status: 'done' };
    }

    const choiceBlock = choiceMatch[1].trim();
    const lines = choiceBlock.split('\n').map(l => l.trim()).filter(Boolean);
    const messageLine = lines.find(l => l.startsWith('message:'));
    const optionLines = lines.filter(l => l.startsWith('- '));

    // If we matched [CHOICES] but found no valid options, treat as plain text
    if (optionLines.length === 0) {
      return { text, status: 'done' };
    }

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
    const textAfter = hasClosingTag
      ? text.slice(text.indexOf('[/CHOICES]') + '[/CHOICES]'.length).trim()
      : '';
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
