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
  id: string;       // Provider-supplied call ID
  name: string;
  arguments: Record<string, unknown>;
}

/** Image content block for multimodal messages */
export interface ImageContent {
  type: 'image';
  data: string;       // base64-encoded
  mediaType: string;  // "image/png", "image/jpeg", etc.
}

/** Text content block for multimodal messages */
export interface TextContent {
  type: 'text';
  text: string;
}

/** A content block — either text or image */
export type ContentBlock = TextContent | ImageContent;

/** A single message in the multi-turn LLM session history */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];  // string for backward compat, array for multimodal
  toolCallId?: string;   // Provider-issued call ID
  name?: string;         // Tool/function name (used by tool role messages)
  toolCalls?: ToolCall[];  // When role === 'assistant' and it made tool calls
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
