/**
 * Multi-provider LLM abstraction.
 *
 * Uses native fetch (no SDK dependencies). Supports:
 * - Anthropic (Claude)
 * - OpenAI (GPT)
 * - Google (Gemini)
 * - Ollama (local models)
 */

import { randomUUID } from 'crypto';
import { ToolDefinition, LLMMessage } from '@gossip/types';
import { LLMResponse } from './types';

export interface LLMGenerateOptions {
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ILLMProvider {
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

export class AnthropicProvider implements ILLMProvider {
  constructor(private apiKey: string, private model: string) {}

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystemMsgs.map(m => this.toAnthropicMessage(m)),
    };
    if (systemMsg) body.system = typeof systemMsg.content === 'string' ? systemMsg.content : '';
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.tools?.length) {
      body.tools = options.tools.map(t => ({
        name: t.name, description: t.description, input_schema: t.parameters,
      }));
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Anthropic API error (${res.status}): ${body}`);
    }
    const data = await res.json() as Record<string, unknown>;
    return this.parseAnthropicResponse(data);
  }

  private toAnthropicMessage(m: LLMMessage): Record<string, unknown> {
    // Multimodal content — translate ContentBlock[] to Anthropic format
    if (typeof m.content !== 'string') {
      return {
        role: m.role,
        content: m.content.map(block =>
          block.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } }
            : { type: 'text', text: block.text }
        ),
      };
    }
    // Tool result — guard content with typeof
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      };
    }
    // Assistant with tool calls — cast content to string
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content as string });
      for (const tc of m.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      return { role: 'assistant', content };
    }
    return { role: m.role, content: m.content };
  }

  private parseAnthropicResponse(data: Record<string, unknown>): LLMResponse {
    const content = data.content as Array<Record<string, unknown>>;
    let text = '';
    const toolCalls: LLMResponse['toolCalls'] = [];
    for (const block of content) {
      if (block.type === 'text') text += block.text as string;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id as string,
          name: block.name as string,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }
    const usage = data.usage as Record<string, number> | undefined;
    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : undefined,
    };
  }
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────

export class OpenAIProvider implements ILLMProvider {
  constructor(private apiKey: string, private model: string) {}

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => this.toOpenAIMessage(m)),
    };
    if (options?.maxTokens) body.max_tokens = options.maxTokens;
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.tools?.length) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`OpenAI API error (${res.status}): ${body}`);
    }
    const data = await res.json() as Record<string, unknown>;
    return this.parseOpenAIResponse(data);
  }

  private toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
    if (typeof m.content !== 'string') {
      return {
        role: m.role,
        content: m.content.map(block =>
          block.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
            : { type: 'text', text: block.text }
        ),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), tool_call_id: m.toolCallId };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant', content: (m.content as string) || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  }

  private parseOpenAIResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>>;
    const msg = choices[0].message as Record<string, unknown>;
    const toolCalls: LLMResponse['toolCalls'] = [];
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, string>;
        toolCalls.push({ id: tc.id as string, name: fn.name, arguments: JSON.parse(fn.arguments) });
      }
    }
    const usage = data.usage as Record<string, number> | undefined;
    return {
      text: (msg.content as string) || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : undefined,
    };
  }
}

// ─── Google Gemini ───────────────────────────────────────────────────────────

export class GeminiProvider implements ILLMProvider {
  constructor(private apiKey: string, private model: string) {}

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const contents = messages.filter(m => m.role !== 'system').map(m => this.toGeminiMessage(m));
    const systemMsg = messages.find(m => m.role === 'system');
    const body: Record<string, unknown> = { contents };
    if (systemMsg) body.systemInstruction = { parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : '' }] };
    if (options?.temperature !== undefined) {
      body.generationConfig = { temperature: options.temperature, maxOutputTokens: options?.maxTokens ?? 8192 };
    }

    // Pass tools as functionDeclarations
    if (options?.tools?.length) {
      body.tools = [{
        functionDeclarations: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = (await res.text()).slice(0, 200);
      throw new Error(`Gemini API error (${res.status}): ${errBody}`);
    }
    return this.parseGeminiResponse(await res.json() as Record<string, unknown>);
  }

  private toGeminiMessage(m: LLMMessage): Record<string, unknown> {
    // Tool result → functionResponse part
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: [{ functionResponse: { name: m.name || 'unknown', response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) } } }],
      };
    }
    // Assistant with tool calls → model with functionCall parts
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: Record<string, unknown>[] = [];
      if (m.content && typeof m.content === 'string' && m.content.trim()) {
        parts.push({ text: m.content });
      }
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      return { role: 'model', parts };
    }
    // Multimodal content
    if (typeof m.content !== 'string') {
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: m.content.map(block =>
          block.type === 'image'
            ? { inlineData: { mimeType: block.mediaType, data: block.data } }
            : { text: block.text }
        ),
      };
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  }

  private parseGeminiResponse(data: Record<string, unknown>): LLMResponse {
    const candidates = data.candidates as Array<Record<string, unknown>>;
    if (!candidates?.length) {
      // Log blocked responses for debugging
      const blockReason = (data as any).promptFeedback?.blockReason;
      if (blockReason) process.stderr.write(`[GeminiProvider] Response blocked: ${blockReason}\n`);
      return { text: '[No response from Gemini]' };
    }
    const candidate = candidates[0];
    const finishReason = candidate.finishReason as string | undefined;
    // STOP = normal, MAX_TOKENS = truncated, tool call reasons = function calling (expected)
    const expectedReasons = ['STOP', 'MAX_TOKENS', 'TOOL_CALL', 'UNEXPECTED_TOOL_CALL'];
    if (finishReason && !expectedReasons.includes(finishReason)) {
      process.stderr.write(`[GeminiProvider] Unusual finishReason: ${finishReason}\n`);
    }
    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = (content?.parts || []) as Array<Record<string, unknown>>;
    if (!parts?.length) {
      // UNEXPECTED_TOOL_CALL: Gemini tried to call a function but the call was malformed.
      // The function call data may be in candidate.content.functionCall or similar.
      // Log and return empty — the orchestrator's retry mechanism will handle this.
      if (finishReason !== 'SAFETY') {
        process.stderr.write(`[GeminiProvider] Empty response parts (finishReason: ${finishReason || 'unknown'}). Returning empty to trigger retry.\n`);
      }
      return { text: finishReason === 'SAFETY' ? '[Response blocked by Gemini safety filter]' : '' };
    }

    const textParts: string[] = [];
    const toolCalls: LLMResponse['toolCalls'] = [];

    for (const part of parts) {
      if (part.text) {
        textParts.push(part.text as string);
      }
      if (part.functionCall) {
        const fc = part.functionCall as { name: string; args: Record<string, unknown>; id?: string };
        toolCalls.push({
          id: fc.id || randomUUID().slice(0, 12),
          name: fc.name,
          arguments: fc.args || {},
        });
      }
    }

    const usage = data.usageMetadata as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    } | undefined;

    return {
      text: textParts.join(''),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage?.promptTokenCount != null ? {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
      } : undefined,
    };
  }
}

// ─── Ollama (local) ─────────────────────────────────────────────────────────

export class OllamaProvider implements ILLMProvider {
  constructor(private model: string, private baseUrl: string = 'http://localhost:11434') {}

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => {
        if (typeof m.content !== 'string') {
          const texts = m.content.filter(b => b.type === 'text').map(b => (b as any).text);
          const images = m.content.filter(b => b.type === 'image').map(b => (b as any).data);
          return {
            role: m.role === 'tool' ? 'user' : m.role,
            content: texts.join(' ') || '',
            ...(images.length ? { images } : {}),
          };
        }
        return { role: m.role === 'tool' ? 'user' : m.role, content: m.content };
      }),
      stream: false,
    };
    if (options?.temperature !== undefined) body.options = { temperature: options.temperature };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Ollama API error (${res.status}): ${body}`);
    }
    const data = await res.json() as Record<string, unknown>;
    const msg = data.message as Record<string, string>;
    return { text: msg.content };
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createProvider(provider: string, model: string, apiKey?: string): ILLMProvider {
  switch (provider) {
    case 'anthropic': return new AnthropicProvider(apiKey!, model);
    case 'openai': return new OpenAIProvider(apiKey!, model);
    case 'google': return new GeminiProvider(apiKey!, model);
    case 'local': return new OllamaProvider(model);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
