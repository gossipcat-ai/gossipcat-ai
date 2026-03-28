"use strict";
/**
 * Multi-provider LLM abstraction.
 *
 * Uses native fetch (no SDK dependencies). Supports:
 * - Anthropic (Claude)
 * - OpenAI (GPT)
 * - Google (Gemini)
 * - Ollama (local models)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaProvider = exports.GeminiProvider = exports.OpenAIProvider = exports.AnthropicProvider = void 0;
exports.createProvider = createProvider;
const crypto_1 = require("crypto");
// ─── Anthropic ──────────────────────────────────────────────────────────────
class AnthropicProvider {
    apiKey;
    model;
    constructor(apiKey, model) {
        this.apiKey = apiKey;
        this.model = model;
    }
    async generate(messages, options) {
        const systemMsg = messages.find(m => m.role === 'system');
        const nonSystemMsgs = messages.filter(m => m.role !== 'system');
        const body = {
            model: this.model,
            max_tokens: options?.maxTokens ?? 4096,
            messages: nonSystemMsgs.map(m => this.toAnthropicMessage(m)),
        };
        if (systemMsg)
            body.system = typeof systemMsg.content === 'string' ? systemMsg.content : '';
        if (options?.temperature !== undefined)
            body.temperature = options.temperature;
        const anthropicTools = [];
        if (options?.tools?.length) {
            anthropicTools.push(...options.tools.map(t => ({
                name: t.name, description: t.description, input_schema: t.parameters,
            })));
        }
        if (options?.webSearch) {
            anthropicTools.push({ type: 'web_search_20250305', name: 'web_search' });
        }
        if (anthropicTools.length > 0)
            body.tools = anthropicTools;
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
        const data = await res.json();
        return this.parseAnthropicResponse(data);
    }
    toAnthropicMessage(m) {
        // Multimodal content — translate ContentBlock[] to Anthropic format
        if (typeof m.content !== 'string') {
            return {
                role: m.role,
                content: m.content.map(block => block.type === 'image'
                    ? { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } }
                    : { type: 'text', text: block.text }),
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
            const content = [];
            if (m.content)
                content.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls) {
                content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
            }
            return { role: 'assistant', content };
        }
        return { role: m.role, content: m.content };
    }
    parseAnthropicResponse(data) {
        const content = data.content;
        let text = '';
        const toolCalls = [];
        for (const block of content) {
            if (block.type === 'text')
                text += block.text;
            if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    arguments: block.input,
                });
            }
        }
        const usage = data.usage;
        return {
            text,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : undefined,
        };
    }
}
exports.AnthropicProvider = AnthropicProvider;
// ─── OpenAI ─────────────────────────────────────────────────────────────────
class OpenAIProvider {
    apiKey;
    model;
    constructor(apiKey, model) {
        this.apiKey = apiKey;
        this.model = model;
    }
    async generate(messages, options) {
        const body = {
            model: this.model,
            messages: messages.map(m => this.toOpenAIMessage(m)),
        };
        if (options?.maxTokens)
            body.max_tokens = options.maxTokens;
        if (options?.temperature !== undefined)
            body.temperature = options.temperature;
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
        const data = await res.json();
        return this.parseOpenAIResponse(data);
    }
    toOpenAIMessage(m) {
        if (typeof m.content !== 'string') {
            return {
                role: m.role,
                content: m.content.map(block => block.type === 'image'
                    ? { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
                    : { type: 'text', text: block.text }),
            };
        }
        if (m.role === 'tool') {
            return { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), tool_call_id: m.toolCallId };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
                role: 'assistant', content: m.content || null,
                tool_calls: m.toolCalls.map(tc => ({
                    id: tc.id, type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
            };
        }
        return { role: m.role, content: m.content };
    }
    parseOpenAIResponse(data) {
        const choices = data.choices;
        const msg = choices[0].message;
        const toolCalls = [];
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                const fn = tc.function;
                toolCalls.push({ id: tc.id, name: fn.name, arguments: JSON.parse(fn.arguments) });
            }
        }
        const usage = data.usage;
        return {
            text: msg.content || '',
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : undefined,
        };
    }
}
exports.OpenAIProvider = OpenAIProvider;
// ─── Google Gemini ───────────────────────────────────────────────────────────
class GeminiProvider {
    apiKey;
    model;
    constructor(apiKey, model) {
        this.apiKey = apiKey;
        this.model = model;
    }
    async generate(messages, options) {
        const contents = messages.filter(m => m.role !== 'system').map(m => this.toGeminiMessage(m));
        const systemMsg = messages.find(m => m.role === 'system');
        const body = { contents };
        if (systemMsg)
            body.systemInstruction = { parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : '' }] };
        if (options?.temperature !== undefined) {
            body.generationConfig = { temperature: options.temperature, maxOutputTokens: options?.maxTokens ?? 8192 };
        }
        // Gemini API: google_search and functionDeclarations CANNOT be combined.
        // If webSearch is enabled, use google_search only (worker agents call
        // their tools via relay RPC, not Gemini function calling).
        // If webSearch is not enabled, use functionDeclarations for native tool calls.
        const toolMode = options?.webSearch ? 'google_search' : options?.tools?.length ? `functionDeclarations(${options.tools.length})` : 'none';
        if (options?.webSearch) {
            body.tools = [{ google_search: {} }];
        }
        else if (options?.tools?.length) {
            body.tools = [{
                    functionDeclarations: options.tools.map(t => ({
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters,
                    })),
                }];
        }
        process.stderr.write(`[Gemini] ${this.model} — ${messages.length} messages, tools=${toolMode}\n`);
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
        const data = await res.json();
        const result = this.parseGeminiResponse(data);
        process.stderr.write(`[Gemini] → text=${result.text?.length ?? 0}chars, toolCalls=${result.toolCalls?.length ?? 0}${result.toolCalls?.length ? ` [${result.toolCalls.map(tc => tc.name).join(', ')}]` : ''}, tokens=${result.usage?.inputTokens ?? '?'}/${result.usage?.outputTokens ?? '?'}\n`);
        return result;
    }
    toGeminiMessage(m) {
        // Tool result → functionResponse part
        if (m.role === 'tool') {
            return {
                role: 'user',
                parts: [{ functionResponse: { name: m.name || 'unknown', response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) } } }],
            };
        }
        // Assistant with tool calls → model with functionCall parts
        if (m.role === 'assistant' && m.toolCalls?.length) {
            const parts = [];
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
                parts: m.content.map(block => block.type === 'image'
                    ? { inlineData: { mimeType: block.mediaType, data: block.data } }
                    : { text: block.text }),
            };
        }
        return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    }
    parseGeminiResponse(data) {
        const candidates = data.candidates;
        if (!candidates?.length) {
            // Log blocked responses for debugging
            const blockReason = data.promptFeedback?.blockReason;
            if (blockReason)
                process.stderr.write(`[GeminiProvider] Response blocked: ${blockReason}\n`);
            return { text: '[No response from Gemini]' };
        }
        const candidate = candidates[0];
        const finishReason = candidate.finishReason;
        // STOP = normal, MAX_TOKENS = truncated, tool call reasons = function calling (expected)
        const expectedReasons = ['STOP', 'MAX_TOKENS', 'TOOL_CALL', 'UNEXPECTED_TOOL_CALL'];
        if (finishReason && !expectedReasons.includes(finishReason)) {
            process.stderr.write(`[GeminiProvider] Unusual finishReason: ${finishReason}\n`);
        }
        const content = candidate.content;
        const parts = (content?.parts || []);
        if (!parts?.length) {
            // UNEXPECTED_TOOL_CALL: Gemini tried to call a function but the call was malformed.
            // The function call data may be in candidate.content.functionCall or similar.
            // Log and return empty — the orchestrator's retry mechanism will handle this.
            if (finishReason !== 'SAFETY') {
                process.stderr.write(`[GeminiProvider] Empty response parts (finishReason: ${finishReason || 'unknown'}). Returning empty to trigger retry.\n`);
            }
            return { text: finishReason === 'SAFETY' ? '[Response blocked by Gemini safety filter]' : '' };
        }
        const textParts = [];
        const toolCalls = [];
        for (const part of parts) {
            if (part.text) {
                textParts.push(part.text);
            }
            if (part.functionCall) {
                const fc = part.functionCall;
                toolCalls.push({
                    id: fc.id || (0, crypto_1.randomUUID)().slice(0, 12),
                    name: fc.name,
                    arguments: fc.args || {},
                });
            }
        }
        const usage = data.usageMetadata;
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
exports.GeminiProvider = GeminiProvider;
// ─── Ollama (local) ─────────────────────────────────────────────────────────
class OllamaProvider {
    model;
    baseUrl;
    constructor(model, baseUrl = 'http://localhost:11434') {
        this.model = model;
        this.baseUrl = baseUrl;
    }
    async generate(messages, options) {
        const body = {
            model: this.model,
            messages: messages.map(m => {
                if (typeof m.content !== 'string') {
                    const texts = m.content.filter(b => b.type === 'text').map(b => b.text);
                    const images = m.content.filter(b => b.type === 'image').map(b => b.data);
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
        if (options?.temperature !== undefined)
            body.options = { temperature: options.temperature };
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const body = (await res.text()).slice(0, 200);
            throw new Error(`Ollama API error (${res.status}): ${body}`);
        }
        const data = await res.json();
        const msg = data.message;
        return { text: msg.content };
    }
}
exports.OllamaProvider = OllamaProvider;
// ─── Factory ────────────────────────────────────────────────────────────────
function createProvider(provider, model, apiKey) {
    switch (provider) {
        case 'anthropic': return new AnthropicProvider(apiKey, model);
        case 'openai': return new OpenAIProvider(apiKey, model);
        case 'google': return new GeminiProvider(apiKey, model);
        case 'local': return new OllamaProvider(model);
        default: throw new Error(`Unknown provider: ${provider}`);
    }
}
//# sourceMappingURL=llm-client.js.map