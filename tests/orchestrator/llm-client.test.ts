import { createProvider, createProviderForAgent, resolveAgentProvider, AnthropicProvider, OpenAIProvider, GeminiProvider, OllamaProvider } from '@gossip/orchestrator';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
    it('throws a clear AUTH error on 401 (issue #522)', async () => {
      // 401/403 now produce a dedicated auth message that points at the
      // keychain, NOT the generic `Anthropic API error (401)` fall-through.
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }) as unknown as typeof fetch;

      const provider = new AnthropicProvider('bad-key', 'claude-3');
      await expect(provider.generate([{ role: 'user', content: 'hello' }]))
        .rejects.toThrow(/Anthropic authentication failed \(HTTP 401\).*keychain/s);

      global.fetch = originalFetch;
    });

    it('throws on non-auth API error (e.g. 500) via the generic path', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal',
      }) as unknown as typeof fetch;

      const provider = new AnthropicProvider('test-key', 'claude-3');
      await expect(provider.generate([{ role: 'user', content: 'hello' }]))
        .rejects.toThrow('Anthropic API error (500): Internal');

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

    it('401 → clear AUTH error that names the keychain and NOT platform.openai.com (issue #522)', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Incorrect API key provided',
      }) as unknown as typeof fetch;

      // DeepSeek / OpenAI-compatible endpoint.
      const provider = new OpenAIProvider('bad-key', 'deepseek-chat', undefined, 'https://api.deepseek.com/v1');
      let caught: Error | undefined;
      try {
        await provider.generate([{ role: 'user', content: 'hi' }]);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/authentication failed \(HTTP 401\)/);
      expect(caught!.message).toMatch(/keychain/);
      // Must reference the configured base_url, never the generic OpenAI host.
      expect(caught!.message).toContain('https://api.deepseek.com/v1');
      expect(caught!.message).not.toContain('platform.openai.com');

      global.fetch = originalFetch;
    });

    it('403 → AUTH error, also avoids platform.openai.com (issue #522)', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      }) as unknown as typeof fetch;

      const provider = new OpenAIProvider('bad-key', 'gpt-4');
      let caught: Error | undefined;
      try {
        await provider.generate([{ role: 'user', content: 'hi' }]);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught!.message).toMatch(/authentication failed \(HTTP 403\)/);
      expect(caught!.message).not.toContain('platform.openai.com');

      global.fetch = originalFetch;
    });

    it('records the auth failure under the key_ref service, not the provider slot (issue #522)', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Incorrect API key provided',
      }) as unknown as typeof fetch;
      const root = mkdtempSync(join(tmpdir(), 'auth-keyref-'));
      try {
        // An openai-provider agent whose key lives at keychain service "my-corp-key".
        const provider = createProvider('openai', 'gpt-4', 'bad-key', root, undefined, 'my-corp-key');
        await provider.generate([{ role: 'user', content: 'hi' }]).catch(() => { /* 401 expected */ });
        const state = JSON.parse(readFileSync(join(root, '.gossip', 'auth-state.json'), 'utf-8'));
        // The recorded slot (and thus the `gossipcat key set <X>` hint) must be the
        // key_ref service, NOT the generic provider name.
        expect(Object.keys(state)).toEqual(['my-corp-key']);
        expect(state['my-corp-key'].status).toBe(401);
      } finally {
        rmSync(root, { recursive: true, force: true });
        global.fetch = originalFetch;
      }
    });

    it('non-auth 500 still uses the generic OpenAI error path', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'boom',
      }) as unknown as typeof fetch;

      const provider = new OpenAIProvider('test-key', 'gpt-4');
      await expect(provider.generate([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow('OpenAI API error (500): boom');

      global.fetch = originalFetch;
    });

    it('malformed tool-call arguments (unquoted key — {depth: 2}) set argumentsParseError, do not throw', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_bad', type: 'function',
                function: { name: 'file_tree', arguments: '{depth: 2}' },
              }],
            },
          }],
        }),
      }) as unknown as typeof fetch;

      const provider = new OpenAIProvider('test-key', 'deepseek-chat', undefined, 'https://api.deepseek.com/v1');
      const response = await provider.generate([{ role: 'user', content: 'list' }]);

      expect(response.toolCalls).toHaveLength(1);
      const tc = response.toolCalls![0];
      expect(tc.name).toBe('file_tree');
      expect(tc.arguments).toEqual({});
      expect(tc.argumentsParseError).toBeDefined();
      expect(tc.rawArguments).toBe('{depth: 2}');

      global.fetch = originalFetch;
    });

    it('malformed tool-call arguments (single-quoted key — {\'path\': \'x\'}) set argumentsParseError', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_sq', type: 'function',
                function: { name: 'file_read', arguments: "{'path': 'x'}" },
              }],
            },
          }],
        }),
      }) as unknown as typeof fetch;

      const provider = new OpenAIProvider('test-key', 'deepseek-chat');
      const response = await provider.generate([{ role: 'user', content: 'read' }]);

      expect(response.toolCalls).toHaveLength(1);
      const tc = response.toolCalls![0];
      expect(tc.argumentsParseError).toBeDefined();
      expect(tc.rawArguments).toBe("{'path': 'x'}");

      global.fetch = originalFetch;
    });

    it('one malformed + one valid tool call in same response: valid call parses normally', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_bad', type: 'function',
                  function: { name: 'file_tree', arguments: '{depth: 2}' },
                },
                {
                  id: 'call_ok', type: 'function',
                  function: { name: 'file_read', arguments: '{"path": "/src/main.ts"}' },
                },
              ],
            },
          }],
        }),
      }) as unknown as typeof fetch;

      const provider = new OpenAIProvider('test-key', 'deepseek-chat');
      const response = await provider.generate([{ role: 'user', content: 'go' }]);

      expect(response.toolCalls).toHaveLength(2);
      const [bad, ok] = response.toolCalls!;

      // Bad call carries the error marker
      expect(bad.name).toBe('file_tree');
      expect(bad.argumentsParseError).toBeDefined();
      expect(bad.rawArguments).toBe('{depth: 2}');

      // Good call parses normally with no marker
      expect(ok.name).toBe('file_read');
      expect(ok.arguments).toEqual({ path: '/src/main.ts' });
      expect(ok.argumentsParseError).toBeUndefined();

      global.fetch = originalFetch;
    });
  });

  describe('createProviderForAgent — pre-flight key check (issue #522)', () => {
    it('key-requiring provider with no key → DegradedProvider that fails the task with a clear message', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const provider = createProviderForAgent('deepseek-agent', 'openai', 'deepseek-chat', undefined, 'https://api.deepseek.com/v1');

      let caught: Error | undefined;
      try {
        await provider.generate([{ role: 'user', content: 'hi' }]);
      } catch (e) {
        caught = e as Error;
      }
      // Fails the TASK (rejects generate) without making an empty-Bearer request.
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('no API key configured for agent "deepseek-agent"');
      expect(caught!.message).toContain('provider openai');
      expect(caught!.message).toContain('https://api.deepseek.com/v1');
      expect(caught!.message).toMatch(/keychain/);
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it('empty-string key is treated as missing', async () => {
      const provider = createProviderForAgent('a1', 'anthropic', 'claude-3', '');
      await expect(provider.generate([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow('no API key configured for agent "a1"');
    });

    it('default base_url is reported as \'default\' when none configured', async () => {
      const provider = createProviderForAgent('a2', 'openai', 'gpt-4', undefined);
      await expect(provider.generate([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/base_url default/);
    });

    it('key-requiring provider WITH a key builds a real provider (no DegradedProvider)', () => {
      const provider = createProviderForAgent('a3', 'openai', 'gpt-4', 'sk-real', 'https://api.deepseek.com/v1');
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it('non-key provider (local/none) builds normally even without a key', () => {
      expect(createProviderForAgent('a4', 'local', 'llama3', undefined)).toBeInstanceOf(OllamaProvider);
      // 'none' resolves to NullProvider which has no exported class; assert it does not throw + resolves empty.
      const nullp = createProviderForAgent('a5', 'none', 'x', undefined);
      return expect(nullp.generate([{ role: 'user', content: 'hi' }])).resolves.toEqual({ text: '' });
    });

    it('DegradedProvider names the keychain SERVICE from key_ref, not the provider (issue #522)', async () => {
      // key_ref:"my-custom-key" on an openai agent → message names that service.
      const provider = createProviderForAgent('cust', 'openai', 'gpt-4', undefined, 'https://api.example.com/v1', undefined, 'my-custom-key');
      let caught: Error | undefined;
      try { await provider.generate([{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('no API key configured for agent "cust"');
      expect(caught!.message).toContain('keychain service "my-custom-key"');
    });

    it('DegradedProvider falls back to provider name when key_ref absent', async () => {
      const provider = createProviderForAgent('a6', 'openai', 'gpt-4', undefined);
      let caught: Error | undefined;
      try { await provider.generate([{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
      expect(caught!.message).toContain('keychain service "openai"');
    });
  });

  describe('provider:"deepseek" — first-class OpenAI-compatible provider (issue #522)', () => {
    it('createProvider("deepseek") → OpenAIProvider', () => {
      const provider = createProvider('deepseek', 'deepseek-chat', 'sk-ds-key');
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it('defaults base_url to https://api.deepseek.com/v1 (named in the auth error)', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 401, text: async () => 'bad key',
      }) as unknown as typeof fetch;

      const provider = createProvider('deepseek', 'deepseek-chat', 'bad-key');
      let caught: Error | undefined;
      try { await provider.generate([{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
      expect(caught!.message).toContain('https://api.deepseek.com/v1');
      // Provider label names DeepSeek, not the generic "OpenAI-compatible".
      expect(caught!.message).toMatch(/^DeepSeek authentication failed/);
      expect(caught!.message).not.toContain('platform.openai.com');

      global.fetch = originalFetch;
    });

    it('explicit base_url overrides the deepseek default', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 401, text: async () => 'bad key',
      }) as unknown as typeof fetch;

      const provider = createProvider('deepseek', 'deepseek-chat', 'bad-key', undefined, 'https://my-proxy.example.com/v1');
      let caught: Error | undefined;
      try { await provider.generate([{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
      expect(caught!.message).toContain('https://my-proxy.example.com/v1');
      expect(caught!.message).not.toContain('api.deepseek.com');

      global.fetch = originalFetch;
    });

    it('deepseek is key-requiring: no key → DegradedProvider naming the deepseek service', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      // key_ref defaults to the provider "deepseek" when absent.
      const provider = createProviderForAgent('ds-agent', 'deepseek', 'deepseek-reasoner', undefined, undefined, undefined, undefined);
      let caught: Error | undefined;
      try { await provider.generate([{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('no API key configured for agent "ds-agent"');
      expect(caught!.message).toContain('provider deepseek');
      expect(caught!.message).toContain('keychain service "deepseek"');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('resolveAgentProvider — extracted pure helper (issue #522)', () => {
    it('key_ref set: getKey called with key_ref service (not provider)', async () => {
      const getKey = jest.fn().mockResolvedValue('sk-custom');
      const provider = await resolveAgentProvider(
        { id: 'a1', provider: 'openai', model: 'gpt-4', key_ref: 'my-custom-key' },
        getKey,
      );
      expect(getKey).toHaveBeenCalledWith('my-custom-key');
      expect(getKey).not.toHaveBeenCalledWith('openai');
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it('key_ref absent: getKey called with provider name (byte-identical fallback)', async () => {
      const getKey = jest.fn().mockResolvedValue('sk-provider');
      const provider = await resolveAgentProvider(
        { id: 'a2', provider: 'openai', model: 'gpt-4' },
        getKey,
      );
      expect(getKey).toHaveBeenCalledWith('openai');
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it('key missing for key-requiring provider → DegradedProvider whose generate() rejects naming the key_ref service', async () => {
      const getKey = jest.fn().mockResolvedValue(null);
      const provider = await resolveAgentProvider(
        { id: 'ds-agent', provider: 'deepseek', model: 'deepseek-chat', key_ref: 'my-deepseek-key' },
        getKey,
      );
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(provider.generate([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/my-deepseek-key/);
      // DegradedProvider must not make a network call.
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('key missing, no key_ref → DegradedProvider names the provider as the keychain service', async () => {
      const getKey = jest.fn().mockResolvedValue(null);
      const provider = await resolveAgentProvider(
        { id: 'a3', provider: 'anthropic', model: 'claude-3' },
        getKey,
      );
      await expect(provider.generate([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/keychain service "anthropic"/);
    });

    it('base_url threaded: deepseek with custom base_url builds provider without throwing', async () => {
      const getKey = jest.fn().mockResolvedValue('sk-ds');
      const provider = await resolveAgentProvider(
        { id: 'ds2', provider: 'deepseek', model: 'deepseek-chat', base_url: 'https://my-proxy.example.com/v1' },
        getKey,
      );
      expect(provider).toBeInstanceOf(OpenAIProvider);
      // Verify base_url is threaded: a 401 error should reference the custom base_url.
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 401, text: async () => 'bad key',
      }) as unknown as typeof fetch;
      let caught: Error | undefined;
      try { await provider.generate([{ role: 'user', content: 'hi' }]); } catch (e) { caught = e as Error; }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('https://my-proxy.example.com/v1');
      global.fetch = originalFetch;
    });
  });

  describe('reasoning_content fallback (deepseek-reasoner, issue #522)', () => {
    async function generateWith(message: Record<string, unknown>): Promise<string> {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      }) as unknown as typeof fetch;
      try {
        const provider = createProvider('deepseek', 'deepseek-reasoner', 'sk-ds');
        const res = await provider.generate([{ role: 'user', content: 'q' }]);
        return res.text;
      } finally {
        global.fetch = originalFetch;
      }
    }

    it('empty-string content falls through to reasoning_content (|| not ??)', async () => {
      expect(await generateWith({ content: '', reasoning_content: 'answer', tool_calls: null })).toBe('answer');
    });

    it('non-empty content is preferred over reasoning_content', async () => {
      expect(await generateWith({ content: 'x', reasoning_content: 'should-not-win', tool_calls: null })).toBe('x');
    });

    it('null content with no reasoning_content yields empty string', async () => {
      expect(await generateWith({ content: null, tool_calls: null })).toBe('');
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

describe('QuotaTracker spend-cap detection (429)', () => {
  let projectRoot: string;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'quota-spend-cap-'));
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const read429State = () =>
    JSON.parse(readFileSync(join(projectRoot, '.gossip', 'quota-state.json'), 'utf-8')).google;

  it('a spend-cap 429 persists reason "spend_cap" with a 24h cooldown', async () => {
    const before = Date.now();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '30']]) as any, // short header must be IGNORED for spend cap
      text: async () =>
        'You exceeded its monthly spending cap. Manage at https://ai.studio/spend',
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider('ai-test', 'gemini-pro', projectRoot);
    await expect(provider.generate([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/monthly spend cap/i);

    const state = read429State();
    expect(state.reason).toBe('spend_cap');
    expect(state.consecutive429s).toBe(1);
    // 24h cooldown, NOT the 30s Retry-After header.
    const remaining = state.exhaustedUntil - before;
    expect(remaining).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000);
  });

  it('matches "spend cap" without the -ing as well (case-insensitive)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Map() as any,
      text: async () => 'PROJECT SPEND CAP EXCEEDED',
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider('ai-test', 'gemini-pro', projectRoot);
    await expect(provider.generate([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/monthly spend cap/i);

    expect(read429State().reason).toBe('spend_cap');
  });

  it('an ordinary quota 429 is unchanged — reason "quota", honours Retry-After', async () => {
    const before = Date.now();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '45']]) as any,
      text: async () => 'Resource has been exhausted (e.g. check quota).',
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider('ai-test', 'gemini-pro', projectRoot);
    await expect(provider.generate([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/quota exhausted/i);

    const state = read429State();
    expect(state.reason).toBe('quota');
    expect(state.consecutive429s).toBe(1);
    // Retry-After 45s is honoured; nowhere near the 24h spend-cap window.
    const remaining = state.exhaustedUntil - before;
    expect(remaining).toBeGreaterThan(40_000);
    expect(remaining).toBeLessThan(60_000);
  });
});
