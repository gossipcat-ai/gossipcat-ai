/**
 * Multi-provider LLM abstraction.
 *
 * Uses native fetch (no SDK dependencies). Supports:
 * - Anthropic (Claude)
 * - OpenAI (GPT)
 * - Google (Gemini)
 * - Ollama (local models)
 */
import { ToolDefinition, LLMMessage } from '@gossip/types';
import { LLMResponse } from './types';
export interface LLMGenerateOptions {
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    webSearch?: boolean;
}
export interface ILLMProvider {
    generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
}
export declare class AnthropicProvider implements ILLMProvider {
    private apiKey;
    private model;
    constructor(apiKey: string, model: string);
    generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
    private toAnthropicMessage;
    private parseAnthropicResponse;
}
export declare class OpenAIProvider implements ILLMProvider {
    private apiKey;
    private model;
    constructor(apiKey: string, model: string);
    generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
    private toOpenAIMessage;
    private parseOpenAIResponse;
}
export declare class GeminiProvider implements ILLMProvider {
    private apiKey;
    private model;
    constructor(apiKey: string, model: string);
    generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
    private toGeminiMessage;
    private parseGeminiResponse;
}
export declare class OllamaProvider implements ILLMProvider {
    private model;
    private baseUrl;
    constructor(model: string, baseUrl?: string);
    generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
}
export declare function createProvider(provider: string, model: string, apiKey?: string): ILLMProvider;
