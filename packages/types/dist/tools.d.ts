/** JSON Schema-style property definition for a tool parameter */
export interface ToolParameterProperty {
    type: string;
    description: string;
    enum?: string[];
}
/** JSON Schema-style tool definition (compatible with multiple LLM providers) */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, ToolParameterProperty>;
        required?: string[];
    };
}
/** A single tool call issued by the LLM */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
/** A single message in the multi-turn LLM session history */
export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    name?: string;
    toolCalls?: ToolCall[];
}
/** Result of a tool execution */
export interface ToolResult {
    callId: string;
    name: string;
    output: string;
    error?: string;
}
/** Result returned by generateWithTools */
export interface GenerateWithToolsResult {
    history: LLMMessage[];
    finalText: string;
}
