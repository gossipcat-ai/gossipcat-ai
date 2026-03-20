/**
 * MainAgent — the developer's single point of contact.
 *
 * Receives natural language tasks, decomposes them via TaskDispatcher,
 * fans out to WorkerAgents, and synthesizes results.
 */
import { AgentConfig, ChatResponse } from './types';
export interface MainAgentConfig {
    provider: string;
    model: string;
    apiKey?: string;
    relayUrl: string;
    agents: AgentConfig[];
}
export declare class MainAgent {
    private llm;
    private registry;
    private dispatcher;
    private workers;
    private relayUrl;
    constructor(config: MainAgentConfig);
    /** Start all worker agents (connect to relay) */
    start(): Promise<void>;
    /** Stop all worker agents */
    stop(): Promise<void>;
    /** Handle a user message: decompose, dispatch, synthesize. Returns structured ChatResponse. */
    handleMessage(userMessage: string): Promise<ChatResponse>;
    /** Handle a user's choice selection — continues the conversation with context */
    handleChoice(originalMessage: string, choiceValue: string): Promise<ChatResponse>;
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
    private executeSubTask;
    private synthesize;
}
