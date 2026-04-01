/**
 * MainAgent — the developer's single point of contact.
 *
 * Receives natural language tasks, decomposes them via TaskDispatcher,
 * fans out to WorkerAgents, and synthesizes results.
 */
import { ILLMProvider } from './llm-client';
import { WorkerAgent } from './worker-agent';
import { AgentConfig, DispatchOptions, PlanState, ChatResponse, HandleMessageOptions, TaskProgressEvent } from './types';
import { ContentBlock } from '@gossip/types';
import { ToolServerCallbacks } from './dispatch-pipeline';
import { TaskGraphSync } from './task-graph-sync';
export interface MainAgentConfig {
    provider: string;
    model: string;
    apiKey?: string;
    relayUrl: string;
    agents: AgentConfig[];
    apiKeys?: Record<string, string>;
    projectRoot?: string;
    llm?: ILLMProvider;
    bootstrapPrompt?: string;
    syncFactory?: () => TaskGraphSync | null;
    toolServer?: ToolServerCallbacks | null;
    keyProvider?: (provider: string) => Promise<string | null>;
}
export declare class MainAgent {
    private llm;
    private currentProvider;
    private currentModel;
    private registry;
    private dispatcher;
    private workers;
    private relayUrl;
    private apiKeys;
    private projectRoot;
    private pipeline;
    private bootstrapPrompt;
    private orchestratorAgent;
    private toolExecutor;
    private projectInitializer;
    private teamManager;
    private keyProviderFn;
    private conversationHistory;
    private lastAcceptedTask;
    private readonly MAX_HISTORY;
    constructor(config: MainAgentConfig);
    /** Start all worker agents (connect to relay) */
    start(): Promise<void>;
    /** Set externally-created workers (used by MCP server to avoid duplicate connections) */
    setWorkers(externalWorkers: Map<string, WorkerAgent>): void;
    dispatch(agentId: string, task: string, options?: DispatchOptions): {
        taskId: string;
        promise: Promise<string>;
    };
    collect(taskIds?: string[], timeoutMs?: number, options?: {
        consensus?: boolean;
    }): Promise<import("./consensus-types").CollectResult>;
    dispatchParallel(tasks: Array<{
        agentId: string;
        task: string;
        options?: DispatchOptions;
    }>, options?: {
        consensus?: boolean;
    }): Promise<{
        taskIds: string[];
        errors: string[];
    }>;
    registerPlan(plan: PlanState): void;
    getChainContext(planId: string, step: number): string;
    recordPlanStepResult(planId: string, step: number, result: string): void;
    getWorker(agentId: string): WorkerAgent | undefined;
    getTask(taskId: string): import("./types").TaskEntry | undefined;
    setGossipPublisher(publisher: any): void;
    setOverlapDetector(detector: any): void;
    setConsensusJudge(judge: any): void;
    runConsensus(results: any[]): Promise<any>;
    setLensGenerator(generator: any): void;
    getSkillGapSuggestions(): string[];
    setSkillIndex(index: any): void;
    setSummaryLlm(llm: any): void;
    getSessionConsensusHistory(): {
        timestamp: string;
        confirmed: number;
        disputed: number;
        unverified: number;
        unique: number;
        summary: string;
    }[];
    getSessionStartTime(): Date;
    getSessionGossip(): import("./types").SessionGossipEntry[];
    getSkillIndex(): any;
    /** Health check for active tasks — diagnostics for "is it working?" */
    getActiveTasksHealth(): {
        id: string;
        agentId: string;
        task: string;
        status: string;
        elapsedMs: number;
        toolCalls: number;
        isLikelyStuck: boolean;
    }[];
    cancelRunningTasks(): number;
    /** Seed conversation history with project context from a prior session */
    seedContext(context: string): void;
    /** Convenience: number of registered agents */
    getAgentCount(): number;
    /** Convenience: whether any agents are registered */
    hasAgents(): boolean;
    /** Convenience: list all registered agent configs */
    getAgentList(): AgentConfig[];
    /** Set a progress callback for plan execution */
    onTaskProgress(cb: (event: TaskProgressEvent) => void): void;
    /** Publish gossip for a native agent result (so relay agents can see it) */
    publishNativeGossip(agentId: string, result: string): Promise<void>;
    /** Record a native agent task in the TaskGraph (for visibility in CLI/sync) */
    recordNativeTask(taskId: string, agentId: string, task: string): void;
    /** Record a native agent task completion in the TaskGraph */
    recordNativeTaskCompleted(taskId: string, result: string, error?: string): void;
    /** Get current orchestrator model info */
    getModel(): {
        provider: string;
        model: string;
    };
    /** Get orchestrator's LLM provider (for consensus engine on mixed native+relay results) */
    getLLM(): ILLMProvider;
    /** Switch orchestrator model at runtime */
    setModel(provider: string, model: string, apiKey?: string): Promise<void>;
    /** Register new agent configs (for hot-reload from config changes) */
    registerAgent(config: AgentConfig): void;
    syncWorkers(keyProvider: (provider: string) => Promise<string | null>): Promise<number>;
    /** Stop a single worker agent */
    stopWorker(agentId: string): Promise<void>;
    /** Stop all worker agents */
    stop(): Promise<void>;
    /** Handle a user message. Default mode is cognitive (tool-calling); 'decompose' preserves the old flow. */
    handleMessage(userMessage: string | ContentBlock[], options?: HandleMessageOptions): Promise<ChatResponse>;
    /** Classify whether a task needs single-agent or multi-agent handling. */
    classifyTaskComplexity(task: string): Promise<'single' | 'multi'>;
    /** Original decompose → assign → dispatch → synthesize flow. */
    private handleMessageDecompose;
    /** Cognitive mode: LLM decides whether to chat or call tools. */
    private handleMessageCognitive;
    /** Handle a user's choice selection — continues the conversation with context */
    handleChoice(_originalMessage: string, choiceValue: string): Promise<ChatResponse>;
    /**
     * Parse LLM response for structured elements.
     * Detects choice blocks in the format:
     *   [CHOICES]
     *   message: How should I proceed?
     *   - option_value | Display Label | Optional hint
     *   - option_value | Display Label
     *   [/CHOICES]
     */
    private parseResponse;
    private handleReviewRequest;
    private executeSubTask;
    private synthesize;
}
