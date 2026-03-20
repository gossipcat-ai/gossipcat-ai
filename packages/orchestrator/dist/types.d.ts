/**
 * @gossip/orchestrator — Type definitions for orchestration layer.
 */
/** Configuration for a worker agent */
export interface AgentConfig {
    id: string;
    provider: 'anthropic' | 'openai' | 'google' | 'local';
    model: string;
    preset?: string;
    skills: string[];
}
/** Result of a worker agent completing a sub-task */
export interface TaskResult {
    agentId: string;
    task: string;
    result: string;
    error?: string;
    duration: number;
}
/** A decomposed sub-task with skill requirements and assignment */
export interface SubTask {
    id: string;
    description: string;
    requiredSkills: string[];
    assignedAgent?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    result?: string;
    error?: string;
}
/** A dispatch plan produced by the TaskDispatcher */
export interface DispatchPlan {
    originalTask: string;
    subTasks: SubTask[];
    strategy: 'single' | 'parallel' | 'sequential';
}
/** A choice option presented to the developer in the chat */
export interface ChatChoice {
    value: string;
    label: string;
    hint?: string;
}
/** Structured chat response — text + optional interactive elements */
export interface ChatResponse {
    /** Main text content */
    text: string;
    /** Optional choices for the developer to pick from */
    choices?: {
        message: string;
        options: ChatChoice[];
        allowCustom?: boolean;
        type?: 'select' | 'confirm' | 'multiselect';
    };
    /** Optional progress indicator */
    status?: 'thinking' | 'working' | 'done' | 'error';
    /** Which agents contributed */
    agents?: string[];
}
/** Normalized LLM response from any provider */
export interface LLMResponse {
    text: string;
    toolCalls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }>;
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
}
