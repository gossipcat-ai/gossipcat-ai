/**
 * Tests for the bounded transport-retry added to llm-client.ts's shared
 * fetchWithRetry503 helper (issue #657) — exercised through OpenAIProvider
 * since that's the provider from the reported incident.
 *
 * Covers:
 *  - a transient ECONNRESET/UND_ERR_CONNECT_TIMEOUT is retried and a
 *    subsequent success is returned (retry-then-succeed)
 *  - persistent transport failures exhaust the bounded retry budget (3 total
 *    attempts) and rethrow
 *  - an HTTP response the server actually returned (401, 400) is NEVER
 *    retried — fetch is called exactly once
 *  - an abort is never retried
 */

import { OpenAIProvider } from '@gossip/orchestrator';

function transportError(code: string, message = 'fetch failed'): Error {
  return Object.assign(new Error(message), { code });
}

describe('llm-client transport-level retry (issue #657)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('retries once on ECONNRESET then succeeds (retry-then-succeed stays visible)', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(transportError('ECONNRESET', 'fetch failed'));
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'recovered', tool_calls: null } }] }),
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4');
    const generatePromise = provider.generate([{ role: 'user', content: 'hi' }]);

    // Let the first attempt reject, then advance past the 1s backoff.
    await jest.advanceTimersByTimeAsync(1_000);

    const response = await generatePromise;
    expect(response.text).toBe('recovered');
    expect(callCount).toBe(2);
  });

  it('retries UND_ERR_CONNECT_TIMEOUT with the named backoff schedule (~1s then ~3s)', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return Promise.reject(transportError('UND_ERR_CONNECT_TIMEOUT', 'fetch failed'));
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok after 2 retries', tool_calls: null } }] }),
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4');
    const generatePromise = provider.generate([{ role: 'user', content: 'hi' }]);

    await jest.advanceTimersByTimeAsync(1_000); // after attempt 1
    await jest.advanceTimersByTimeAsync(3_000); // after attempt 2

    const response = await generatePromise;
    expect(response.text).toBe('ok after 2 retries');
    expect(callCount).toBe(3);
  });

  it('exhausts the bounded retry budget (3 total attempts) and rethrows on persistent transport failure', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.reject(transportError('ECONNRESET', 'fetch failed'));
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4');
    const generatePromise = provider.generate([{ role: 'user', content: 'hi' }]);
    // Suppress unhandled-rejection noise until we await below.
    generatePromise.catch(() => {});

    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(generatePromise).rejects.toThrow('fetch failed');
    expect(callCount).toBe(3); // 1 initial + 2 retries, per TRANSPORT_RETRY_MAX_ATTEMPTS
  });

  it('does NOT retry a 401 the server actually returned — fetch called exactly once', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Incorrect API key provided',
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('bad-key', 'gpt-4');
    await expect(provider.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(/authentication failed/);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it('does NOT retry a 400 invalid-model error the server actually returned — fetch called exactly once', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid model id',
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'not-a-real-model');
    await expect(provider.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(/OpenAI API error \(400\)/);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it('does NOT retry on abort — fetch called exactly once', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4');
    await expect(provider.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow('This operation was aborted');
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });
});
