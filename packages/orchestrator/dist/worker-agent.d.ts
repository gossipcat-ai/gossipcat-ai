/**
 * WorkerAgent — executes a sub-task using its LLM and requests tools via relay.
 *
 * Multi-turn tool loop with max 10 turns to prevent infinite loops.
 * Tool calls are sent as RPC_REQUEST to tool-server via relay.
 */
import { ToolDefinition } from '@gossip/types';
import { ILLMProvider } from './llm-client';
export declare class WorkerAgent {
    private agentId;
    private llm;
    private tools;
    private agent;
    private pendingToolCalls;
    constructor(agentId: string, llm: ILLMProvider, relayUrl: string, tools: ToolDefinition[]);
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Execute a task with the LLM, using multi-turn tool calling.
     * Returns the final text response.
     */
    executeTask(task: string, context?: string): Promise<string>;
    /** Send RPC_REQUEST to tool-server via relay */
    private callTool;
    /** Handle incoming messages — resolve pending RPC tool calls */
    private handleMessage;
}
