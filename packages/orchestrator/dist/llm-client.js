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
            body.system = systemMsg.content;
        if (options?.temperature !== undefined)
            body.temperature = options.temperature;
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
        if (!res.ok)
            throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        return this.parseAnthropicResponse(data);
    }
    toAnthropicMessage(m) {
        if (m.role === 'tool') {
            return {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
            };
        }
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
        if (!res.ok)
            throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        return this.parseOpenAIResponse(data);
    }
    toOpenAIMessage(m) {
        if (m.role === 'tool') {
            return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
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
        const contents = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));
        const systemMsg = messages.find(m => m.role === 'system');
        const body = { contents };
        if (systemMsg)
            body.systemInstruction = { parts: [{ text: systemMsg.content }] };
        if (options?.temperature !== undefined) {
            body.generationConfig = { temperature: options.temperature, maxOutputTokens: options?.maxTokens ?? 4096 };
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok)
            throw new Error(`Gemini API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        const candidates = data.candidates;
        const parts = candidates[0].content.parts;
        return { text: parts.map(p => p.text).join('') };
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
            messages: messages.map(m => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content })),
            stream: false,
        };
        if (options?.temperature !== undefined)
            body.options = { temperature: options.temperature };
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok)
            throw new Error(`Ollama API error (${res.status}): ${await res.text()}`);
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