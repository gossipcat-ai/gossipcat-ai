/**
 * Tests for the two medium-severity findings fixed on top of the #657
 * transport-retry loop:
 *
 *  1. Retry is idempotency-safe — the retryable transport-error set is split
 *     by phase ('pre-send' vs 'ambiguous', see error-format.ts's
 *     classifyTransportError). Pre-send failures (never reached the server)
 *     retry unconditionally. Ambiguous failures (may have already reached/been
 *     processed by the server) retry ONLY when an Idempotency-Key was sent —
 *     Anthropic and the canonical OpenAI endpoint send one; Gemini does not
 *     (undocumented support), so ambiguous failures stay non-retried there.
 *  2. The backoff sleep (both the new transport-retry backoff and the
 *     pre-existing 503 one-shot-retry sleep) is abort-aware: a caller
 *     AbortSignal firing mid-backoff returns promptly instead of sleeping out
 *     the full window.
 *
 * Also re-confirms the pre-existing "503 is not amplified by the outer
 * transport-retry loop" property still holds after these changes.
 */

import { OpenAIProvider, GeminiProvider } from '@gossip/orchestrator';

function transportError(code: string, message = 'fetch failed'): Error {
  return Object.assign(new Error(message), { code });
}

function geminiOkResponse(text: string) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  };
}

function openaiOkResponse(text: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: text, tool_calls: null } }] }),
  };
}

describe('idempotency-safe transport retry (issue #657 follow-up, finding 1)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('a pre-send error (UND_ERR_CONNECT_TIMEOUT) retries WITHOUT an idempotency key (Gemini sends none)', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(transportError('UND_ERR_CONNECT_TIMEOUT'));
      return Promise.resolve(geminiOkResponse('recovered'));
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider('test-key', 'gemini-pro');
    const generatePromise = provider.generate([{ role: 'user', content: 'hi' }]);

    await jest.advanceTimersByTimeAsync(1_000);

    const response = await generatePromise;
    expect(response.text).toBe('recovered');
    expect(callCount).toBe(2);

    // Confirm Gemini never sent an Idempotency-Key (unsupported/undocumented).
    for (const call of (global.fetch as jest.Mock).mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('an ambiguous error (ECONNRESET) does NOT retry when no idempotency key was sent (Gemini) — fetch called exactly once', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      return Promise.reject(transportError('ECONNRESET'));
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider('test-key', 'gemini-pro');
    const generatePromise = provider.generate([{ role: 'user', content: 'hi' }]);
    generatePromise.catch(() => {});

    await expect(generatePromise).rejects.toThrow('fetch failed');
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it('an ambiguous error (ECONNRESET) DOES retry when an idempotency key was sent (canonical OpenAI)', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(transportError('ECONNRESET'));
      return Promise.resolve(openaiOkResponse('recovered'));
    }) as unknown as typeof fetch;

    // Default base_url resolves to the canonical api.openai.com endpoint.
    const provider = new OpenAIProvider('test-key', 'gpt-4');
    const generatePromise = provider.generate([{ role: 'user', content: 'hi' }]);

    await jest.advanceTimersByTimeAsync(1_000);

    const response = await generatePromise;
    expect(response.text).toBe('recovered');
    expect(callCount).toBe(2);

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect((calls[0][1].headers as Record<string, string>)['Idempotency-Key']).toEqual(expect.any(String));
  });

  it('reuses the SAME idempotency key across every retry attempt of one logical generate() call', async () => {
    global.fetch = jest.fn().mockImplementation(() => Promise.reject(transportError('ECONNRESET'))) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4');
    const generatePromise = provider.generate([{ role: 'user', content: 'hi' }]);
    generatePromise.catch(() => {});

    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(generatePromise).rejects.toThrow('fetch failed');

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.length).toBe(3); // 1 initial + 2 retries
    const keys = calls.map(c => (c[1].headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });

  it('two SEPARATE generate() calls get two DIFFERENT idempotency keys', async () => {
    global.fetch = jest.fn().mockImplementation(() => Promise.resolve(openaiOkResponse('ok'))) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4');
    await provider.generate([{ role: 'user', content: 'first' }]);
    await provider.generate([{ role: 'user', content: 'second' }]);

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    const key1 = (calls[0][1].headers as Record<string, string>)['Idempotency-Key'];
    const key2 = (calls[1][1].headers as Record<string, string>)['Idempotency-Key'];
    expect(key1).toEqual(expect.any(String));
    expect(key2).toEqual(expect.any(String));
    expect(key1).not.toBe(key2);
  });

  it('does NOT send an Idempotency-Key for a non-canonical OpenAI-compatible base_url (unconfirmed support)', async () => {
    global.fetch = jest.fn().mockImplementation(() => Promise.resolve(openaiOkResponse('ok'))) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'deepseek-chat', undefined, 'https://api.deepseek.com/v1');
    await provider.generate([{ role: 'user', content: 'hi' }]);

    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });
});

describe('abort-aware backoff (issue #657 follow-up, finding 2)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns promptly when the caller AbortSignal fires during the transport-retry backoff, instead of sleeping the full window', async () => {
    global.fetch = jest.fn().mockImplementation(() => Promise.reject(transportError('UND_ERR_CONNECT_TIMEOUT'))) as unknown as typeof fetch;

    // Small timeoutMs so the provider's own AbortSignal.timeout(...) fires well
    // inside the 1s first-backoff window. Real timers — AbortSignal.timeout is
    // not driven by jest's fake timer patches.
    const provider = new OpenAIProvider('test-key', 'gpt-4', undefined, undefined, undefined, 50);

    const start = Date.now();
    await expect(provider.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    const elapsed = Date.now() - start;

    // Backoff schedule is 1000ms/3000ms. If the sleep were not abort-aware,
    // this would take at least 1000ms. An abort-aware sleep returns as soon as
    // the ~50ms timeout fires.
    expect(elapsed).toBeLessThan(800);
  }, 10_000);

  it('returns promptly when the caller AbortSignal fires during the pre-existing 503 one-shot-retry sleep', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => 'service unavailable',
    }) as unknown as typeof fetch;

    // 503's default sleep is 5s (no Retry-After header) — a 50ms timeout fires
    // well inside that window.
    const provider = new OpenAIProvider('test-key', 'gpt-4', undefined, undefined, undefined, 50);

    const start = Date.now();
    await expect(provider.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);
});

describe('503 is still NOT amplified by the outer transport-retry loop (regression, unchanged property)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('a persistent 503 response resolves (never throws out of fetchWithRetry503) and is handled by handle503 after exactly 2 fetch calls', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => 'service unavailable',
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('test-key', 'gpt-4');
    const generatePromise = provider.generate([{ role: 'user', content: 'hi' }]);
    generatePromise.catch(() => {});

    // Default 503 sleep with no Retry-After header is 5s.
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(generatePromise).rejects.toThrow(/service unavailable/);
    // Exactly 2 fetch calls: the one-shot 503 retry inside
    // fetchOnceWithServiceUnavailableRetry — the outer transport-retry loop in
    // fetchWithRetry503 never sees an exception (503 is a resolved Response,
    // not a thrown transport error) so it never adds additional attempts.
    expect(callCount).toBe(2);
  });
});
