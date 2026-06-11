/**
 * Tests for the fetch timeout mechanism added to packages/dashboard-v2/src/lib/api.ts
 * (issue #547 client-side vector, a3a35da1-060d4a81:f6).
 *
 * Root cause: api() had no timeout, so a never-resolving request kept
 * useDashboardData's inFlight ref permanently true (set before fetch, cleared
 * in finally), freezing the 5-second poll forever and leaving the dashboard
 * in a silent "Loading dashboard..." state.
 *
 * Fix: api() wraps every fetch with an AbortController timeout (default 30s).
 * On abort, it throws Error('timeout after 30s') so namedFetch can label the
 * error with the endpoint name: "consensus: timeout after 30s".
 *
 * WHAT IS TESTED HERE (pure helpers, node-safe):
 *   - timeoutMessage(): format contract that the error card depends on.
 *   - API_TIMEOUT_MS: value is a positive number (sanity, catches accidental 0).
 *   - Message produced for abort is in the format namedFetch expects.
 *
 * WHAT IS NOT TESTED HERE (requires fetch + jsdom):
 *   - The actual AbortController/AbortSignal.timeout path inside api() requires
 *     a fetch mock and jsdom timer control not available in the node test env.
 *     Hook-level coverage should be added when jsdom is configured (precedent:
 *     useDashboardData.test.ts:75-80, useTheme.test.ts:10-12).
 */

import { timeoutMessage, API_TIMEOUT_MS } from '../../packages/dashboard-v2/src/lib/api';

describe('api timeout — timeoutMessage helper', () => {
  it('formats 30s timeout correctly', () => {
    expect(timeoutMessage(30_000)).toBe('timeout after 30s');
  });

  it('formats 5s timeout correctly (edge case)', () => {
    expect(timeoutMessage(5_000)).toBe('timeout after 5s');
  });

  it('message matches the pattern that namedFetch labels with endpoint', () => {
    // namedFetch wraps raw message: formatFetchError('consensus', timeoutMessage(30_000))
    // → 'consensus: timeout after 30s'
    // Verify the raw message does NOT look like an HTTP error so it passes through verbatim.
    const msg = timeoutMessage(30_000);
    expect(msg).not.toMatch(/^API error: \d+$/);
    expect(msg).toContain('timeout');
    expect(msg).toContain('30s');
  });

  it('API_TIMEOUT_MS is a positive number', () => {
    expect(typeof API_TIMEOUT_MS).toBe('number');
    expect(API_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('API_TIMEOUT_MS matches the value used in timeoutMessage (self-consistency)', () => {
    // If someone changes the constant, the message must stay coherent.
    const msg = timeoutMessage(API_TIMEOUT_MS);
    expect(msg).toBe(`timeout after ${API_TIMEOUT_MS / 1000}s`);
  });
});

describe('api timeout — abort path (documented, not mechanically testable in node env)', () => {
  it.todo(
    'api() aborts after API_TIMEOUT_MS and throws Error whose message is timeoutMessage(API_TIMEOUT_MS)',
  );

  it.todo(
    'when api() throws a timeout error, namedFetch labels it: "consensus: timeout after 30s"',
  );

  it.todo(
    'after a timeout, inFlight ref is cleared (finally block runs) so the next poll fires normally',
  );
});
