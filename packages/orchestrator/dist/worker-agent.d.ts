/**
 * WorkerAgent — executes a sub-task using its LLM and requests tools via relay.
 *
 * Multi-turn tool loop with max 10 turns to prevent infinite loops.
 * Tool calls are sent as RPC_REQUEST to tool-server via relay.
 */
import { ToolDefinition } from '@gossip/types';
import { ILLMProvider } from './llm-client';
import { TaskExecutionResult } from './types';
export type WorkerProgressCallback = (event: {
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    currentTool: string;
    turn: number;
}) => void;
export type TaskCompleteCallback = (event: {
    agentId: string;
    taskId: string;
    toolCalls: number;
    durationMs: number;
}) => void;
export declare class WorkerAgent {
    private agentId;
    private llm;
    private tools;
    private agent;
    private instructions;
    private gossipQueue;
    private static readonly MAX_GOSSIP_QUEUE;
    private pendingToolCalls;
    private webSearchEnabled;
    private validToolNames;
    private onTaskComplete?;
    constructor(agentId: string, llm: ILLMProvider, relayUrl: string, tools: ToolDefinition[], instructions?: string, webSearch?: boolean);
    setOnTaskComplete(cb: TaskCompleteCallback): void;
    setInstructions(instructions: string): void;
    getInstructions(): string;
    subscribeToBatch(batchId: string): Promise<void>;
    unsubscribeFromBatch(batchId: string): Promise<void>;
    start(): Promise<void>;
    private rejectPendingToolCalls;
    stop(): Promise<void>;
    /**
     * Execute a task with the LLM, using multi-turn tool calling.
     * Returns the final text response.
     */
    executeTask(task: string, context?: string, skillsContent?: string, onProgress?: WorkerProgressCallback): Promise<TaskExecutionResult>;
    /** Send RPC_REQUEST to tool-server via relay */
    private callTool;
    /** Handle incoming messages — resolve pending RPC tool calls */
    private handleMessage;
}
