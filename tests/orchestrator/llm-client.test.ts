import { createProvider, AnthropicProvider, OpenAIProvider, GeminiProvider, OllamaProvider } from '@gossip/orchestrator';

describe('LLM Client', () => {
  describe('createProvider', () => {
    it('creates AnthropicProvider', () => {
      const provider = createProvider('anthropic', 'claude-3-5-sonnet', 'sk-ant-test');
      expect(provider).toBeInstanceOf(AnthropicProvider);
    });

    it('creates OpenAIProvider', () => {
      const provider = createProvider('openai', 'gpt-4', 'sk-test');
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it('creates GeminiProvider', () => {
      const provider = createProvider('google', 'gemini-pro', 'ai-test');
      expect(provider).toBeInstanceOf(GeminiProvider);
    });

    it('creates OllamaProvider for local', () => {
      const provider = createProvider('local', 'qwen2.5-coder');
      expect(provider).toBeInstanceOf(OllamaProvider);
    });

    it('throws for unknown provider', () => {
      expect(() => createProvider('unknown', 'model')).toThrow('Unknown provider: unknown');
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
      }) as unknown as typeof fetch;

      const provider = new AnthropicProvider('bad-key', 'claude-3');
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
      }) as unknown as typeof fetch;

      const provider = new AnthropicProvider('test-key', 'claude-3');
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
      }) as unknown as typeof fetch;

      const provider = new AnthropicProvider('test-key', 'claude-3');
      const response = await provider.generate(
        [{ role: 'user', content: 'read file' }],
        { tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } } } }] }
      );

      expect(response.text).toBe('Let me read that file.');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0]).toEqual({
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
      }) as unknown as typeof fetch;

      const provider = new OpenAIProvider('test-key', 'gpt-4');
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
      }) as unknown as typeof fetch;

      const provider = new OpenAIProvider('test-key', 'gpt-4');
      const response = await provider.generate([{ role: 'user', content: 'list files' }]);

      expect(response.text).toBe('');
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0]).toEqual({
        id: 'call_abc', name: 'shell_exec', arguments: { command: 'ls' },
      });

      global.fetch = originalFetch;
    });
  });
});
