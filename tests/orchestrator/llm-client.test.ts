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

    it('createProvider("none", ...) returns a NullProvider that resolves with { text: "" }', async () => {
      const provider = createProvider('none', 'any-model');
      const result = await provider.generate([{ role: 'user', content: 'hello' }]);
      expect(result.text).toBe('');
    });
  });

  describe('NullProvider (via createProvider("none", ...))', () => {
    it('generate() resolves without throwing', async () => {
      const provider = createProvider('none', 'any');
      await expect(provider.generate([{ role: 'user', content: 'test' }])).resolves.not.toThrow();
    });

    it('generate() resolves to { text: "" } with no toolCalls', async () => {
      const provider = createProvider('none', 'any');
      const result = await provider.generate([{ role: 'user', content: 'hello' }]);
      expect(result).toEqual({ text: '' });
      expect(result.toolCalls).toBeUndefined();
    });

    it('generate() ignores all options without throwing', async () => {
      const provider = createProvider('none', 'any');
      const result = await provider.generate(
        [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
        { tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }], temperature: 0.5, maxTokens: 1000 },
      );
      expect(result.text).toBe('');
    });

    it('generate() never makes network calls (no fetch required)', async () => {
      const provider = createProvider('none', 'any');
      const fetchSpy = jest.spyOn(global, 'fetch');
      await provider.generate([{ role: 'user', content: 'should not fetch' }]);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
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

    it('retries once on 503 and succeeds on second attempt', async () => {
      // Regression for the "503 in-task retry" gap (next-session item #6).
      // Many 503s clear within seconds; one short retry recovers the request
      // before triggering the cooldown dance in QuotaTracker.handle503.
      const originalFetch = global.fetch;
      const calls: number[] = [];
      global.fetch = jest.fn().mockImplementation(() => {
        calls.push(Date.now());
        if (calls.length === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            headers: new Map([['retry-after', '0']]) as any,
            text: async () => 'overloaded',
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: 'recovered' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        });
      }) as unknown as typeof fetch;

      const provider = new AnthropicProvider('test-key', 'claude-3');
      const response = await provider.generate([{ role: 'user', content: 'hi' }]);

      expect(response.text).toBe('recovered');
      expect(calls.length).toBe(2);
      global.fetch = originalFetch;
    }, 15_000);

    it('throws via handle503 after retry also returns 503', async () => {
      const originalFetch = global.fetch;
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Map([['retry-after', '0']]) as any,
          text: async () => 'still overloaded',
        });
      }) as unknown as typeof fetch;

      const provider = new AnthropicProvider('test-key', 'claude-3');
      await expect(provider.generate([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/quota exhausted|service unavailable/);
      expect(callCount).toBe(2);  // one initial + one retry
      global.fetch = originalFetch;
    }, 15_000);

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

describe('Multimodal message formatting', () => {
  const multimodalMessage = {
    role: 'user' as const,
    content: [
      { type: 'image' as const, data: 'base64data', mediaType: 'image/png' },
      { type: 'text' as const, text: 'What is this?' },
    ],
  };

  it('AnthropicProvider formats multimodal content', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'response' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('test-key', 'claude-3');
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
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'response' } }] }) };
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4o');
    await provider.generate([multimodalMessage]);

    const userMsg = sentBody.messages[0];
    expect(userMsg.content[0].type).toBe('image_url');
    expect(userMsg.content[0].image_url.url).toContain('data:image/png;base64,base64data');
    expect(userMsg.content[1].type).toBe('text');
  });

  describe('GeminiProvider token usage', () => {
    it('extracts token usage from Gemini usageMetadata', () => {
      const provider = new GeminiProvider('gemini-pro', 'test-key');
      const mockResponse = {
        candidates: [{
          content: { parts: [{ text: 'Hello' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 150,
          candidatesTokenCount: 42,
        },
      };

      const result = (provider as any).parseGeminiResponse(mockResponse);

      expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 42 });
    });

    it('returns malformed_function_call sentinel when finishReason=MALFORMED_FUNCTION_CALL with empty parts', () => {
      const provider = new GeminiProvider('gemini-pro', 'test-key');
      const mockResponse = {
        candidates: [{
          content: { parts: [] },
          finishReason: 'MALFORMED_FUNCTION_CALL',
        }],
      };

      const result = (provider as any).parseGeminiResponse(mockResponse);

      expect(result.text).toContain('malformed_function_call');
      expect(result.text).toContain('MALFORMED_FUNCTION_CALL');
      // Preserves collect.ts:178 substring match for auto-signal.
      expect(result.text).toContain('[No response from');
    });

    it('returns undefined usage when Gemini has no usageMetadata', () => {
      const provider = new GeminiProvider('gemini-pro', 'test-key');
      const mockResponse = {
        candidates: [{
          content: { parts: [{ text: 'Hello' }] },
          finishReason: 'STOP',
        }],
      };

      const result = (provider as any).parseGeminiResponse(mockResponse);

      expect(result.usage).toBeUndefined();
    });
  });

  it('GeminiProvider formats multimodal content', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'response' }] } }] }) };
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider('test-key', 'gemini-pro');
    await provider.generate([multimodalMessage]);

    const userContent = sentBody.contents[0];
    expect(userContent.parts[0].inlineData.mimeType).toBe('image/png');
    expect(userContent.parts[0].inlineData.data).toBe('base64data');
    expect(userContent.parts[1].text).toBe('What is this?');
  });

  it('OllamaProvider formats multimodal content', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ message: { content: 'response' } }) };
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider('llava');
    await provider.generate([multimodalMessage]);

    const userMsg = sentBody.messages[0];
    expect(userMsg.content).toBe('What is this?');
    expect(userMsg.images).toEqual(['base64data']);
  });

  it('providers handle string content unchanged', async () => {
    let sentBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'r' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('test-key', 'claude-3');
    await provider.generate([{ role: 'user', content: 'plain text' }]);

    expect(sentBody.messages[0].content).toBe('plain text');
  });
});
