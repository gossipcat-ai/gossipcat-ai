"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
describe('LLM Client', () => {
    describe('createProvider', () => {
        it('creates AnthropicProvider', () => {
            const provider = (0, orchestrator_1.createProvider)('anthropic', 'claude-3-5-sonnet', 'sk-ant-test');
            expect(provider).toBeInstanceOf(orchestrator_1.AnthropicProvider);
        });
        it('creates OpenAIProvider', () => {
            const provider = (0, orchestrator_1.createProvider)('openai', 'gpt-4', 'sk-test');
            expect(provider).toBeInstanceOf(orchestrator_1.OpenAIProvider);
        });
        it('creates GeminiProvider', () => {
            const provider = (0, orchestrator_1.createProvider)('google', 'gemini-pro', 'ai-test');
            expect(provider).toBeInstanceOf(orchestrator_1.GeminiProvider);
        });
        it('creates OllamaProvider for local', () => {
            const provider = (0, orchestrator_1.createProvider)('local', 'qwen2.5-coder');
            expect(provider).toBeInstanceOf(orchestrator_1.OllamaProvider);
        });
        it('throws for unknown provider', () => {
            expect(() => (0, orchestrator_1.createProvider)('unknown', 'model')).toThrow('Unknown provider: unknown');
        });
    });
    describe('AnthropicProvider', () => {
        it('throws on API error', async () => {
            // Mock fetch to return error
            const originalFetch = global.fetch;
            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 401,
                text: async () => 'Unauthorized',
            });
            const provider = new orchestrator_1.AnthropicProvider('bad-key', 'claude-3');
            await expect(provider.generate([{ role: 'user', content: 'hello' }]))
                .rejects.toThrow('Anthropic API error (401): Unauthorized');
            global.fetch = originalFetch;
        });
        it('parses text response correctly', async () => {
            const originalFetch = global.fetch;
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    content: [{ type: 'text', text: 'Hello world' }],
                    usage: { input_tokens: 10, output_tokens: 5 },
                }),
            });
            const provider = new orchestrator_1.AnthropicProvider('test-key', 'claude-3');
            const response = await provider.generate([{ role: 'user', content: 'hi' }]);
            expect(response.text).toBe('Hello world');
            expect(response.toolCalls).toBeUndefined();
            expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
            global.fetch = originalFetch;
        });
        it('parses tool_use response correctly', async () => {
            const originalFetch = global.fetch;
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    content: [
                        { type: 'text', text: 'Let me read that file.' },
                        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/tmp/test.ts' } },
                    ],
                    usage: { input_tokens: 20, output_tokens: 15 },
                }),
            });
            const provider = new orchestrator_1.AnthropicProvider('test-key', 'claude-3');
            const response = await provider.generate([{ role: 'user', content: 'read file' }], { tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } } } }] });
            expect(response.text).toBe('Let me read that file.');
            expect(response.toolCalls).toHaveLength(1);
            expect(response.toolCalls[0]).toEqual({
                id: 'call_1', name: 'read_file', arguments: { path: '/tmp/test.ts' },
            });
            global.fetch = originalFetch;
        });
    });
    describe('OpenAIProvider', () => {
        it('parses text response correctly', async () => {
            const originalFetch = global.fetch;
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: 'Hello from GPT', tool_calls: null } }],
                    usage: { prompt_tokens: 10, completion_tokens: 5 },
                }),
            });
            const provider = new orchestrator_1.OpenAIProvider('test-key', 'gpt-4');
            const response = await provider.generate([{ role: 'user', content: 'hi' }]);
            expect(response.text).toBe('Hello from GPT');
            expect(response.toolCalls).toBeUndefined();
            expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
            global.fetch = originalFetch;
        });
        it('parses tool call response correctly', async () => {
            const originalFetch = global.fetch;
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    choices: [{
                            message: {
                                content: null,
                                tool_calls: [{
                                        id: 'call_abc', type: 'function',
                                        function: { name: 'shell_exec', arguments: '{"command":"ls"}' },
                                    }],
                            },
                        }],
                }),
            });
            const provider = new orchestrator_1.OpenAIProvider('test-key', 'gpt-4');
            const response = await provider.generate([{ role: 'user', content: 'list files' }]);
            expect(response.text).toBe('');
            expect(response.toolCalls).toHaveLength(1);
            expect(response.toolCalls[0]).toEqual({
                id: 'call_abc', name: 'shell_exec', arguments: { command: 'ls' },
            });
            global.fetch = originalFetch;
        });
    });
});
describe('Multimodal message formatting', () => {
    const multimodalMessage = {
        role: 'user',
        content: [
            { type: 'image', data: 'base64data', mediaType: 'image/png' },
            { type: 'text', text: 'What is this?' },
        ],
    };
    it('AnthropicProvider formats multimodal content', async () => {
        let sentBody = null;
        global.fetch = jest.fn().mockImplementation(async (_url, opts) => {
            sentBody = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'response' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
        });
        const provider = new orchestrator_1.AnthropicProvider('test-key', 'claude-3');
        await provider.generate([
            { role: 'system', content: 'You are helpful.' },
            multimodalMessage,
        ]);
        expect(typeof sentBody.system).toBe('string');
        const userMsg = sentBody.messages[0];
        expect(userMsg.content[0].type).toBe('image');
        expect(userMsg.content[0].source.type).toBe('base64');
        expect(userMsg.content[0].source.data).toBe('base64data');
        expect(userMsg.content[1].type).toBe('text');
    });
    it('OpenAIProvider formats multimodal content', async () => {
        let sentBody = null;
        global.fetch = jest.fn().mockImplementation(async (_url, opts) => {
            sentBody = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ choices: [{ message: { content: 'response' } }] }) };
        });
        const provider = new orchestrator_1.OpenAIProvider('test-key', 'gpt-4o');
        await provider.generate([multimodalMessage]);
        const userMsg = sentBody.messages[0];
        expect(userMsg.content[0].type).toBe('image_url');
        expect(userMsg.content[0].image_url.url).toContain('data:image/png;base64,base64data');
        expect(userMsg.content[1].type).toBe('text');
    });
    it('GeminiProvider formats multimodal content', async () => {
        let sentBody = null;
        global.fetch = jest.fn().mockImplementation(async (_url, opts) => {
            sentBody = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'response' }] } }] }) };
        });
        const provider = new orchestrator_1.GeminiProvider('test-key', 'gemini-pro');
        await provider.generate([multimodalMessage]);
        const userContent = sentBody.contents[0];
        expect(userContent.parts[0].inlineData.mimeType).toBe('image/png');
        expect(userContent.parts[0].inlineData.data).toBe('base64data');
        expect(userContent.parts[1].text).toBe('What is this?');
    });
    it('OllamaProvider formats multimodal content', async () => {
        let sentBody = null;
        global.fetch = jest.fn().mockImplementation(async (_url, opts) => {
            sentBody = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ message: { content: 'response' } }) };
        });
        const provider = new orchestrator_1.OllamaProvider('llava');
        await provider.generate([multimodalMessage]);
        const userMsg = sentBody.messages[0];
        expect(userMsg.content).toBe('What is this?');
        expect(userMsg.images).toEqual(['base64data']);
    });
    it('providers handle string content unchanged', async () => {
        let sentBody = null;
        global.fetch = jest.fn().mockImplementation(async (_url, opts) => {
            sentBody = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'r' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
        });
        const provider = new orchestrator_1.AnthropicProvider('test-key', 'claude-3');
        await provider.generate([{ role: 'user', content: 'plain text' }]);
        expect(sentBody.messages[0].content).toBe('plain text');
    });
});
//# sourceMappingURL=llm-client.test.js.map