/**
 * Regression tests for issue #547 — dashboard silent infinite "Loading dashboard..." state.
 *
 * THE BUG (verified against the pre-fix code):
 *   - useDashboardData fetches 4 core endpoints via Promise.all with no .catch().
 *   - If any rejects, the whole Promise.all rejects with a bare "Failed to fetch" or
 *     "API error: 500" — no endpoint name, zero diagnostic context.
 *   - The catch block (line ~153) set loading:false + error, but App.tsx never read
 *     `error` from the hook destructure — so the gate `if (loading || !overview)`
 *     stayed true forever with a spinner and no user-visible error message.
 *
 * WHAT IS TESTED HERE:
 *   - formatFetchError (exported pure helper): verifies the error labeling contract
 *     that names the failing endpoint + formats HTTP status vs. network errors.
 *
 * WHAT IS NOT TESTED HERE (component + hook layer):
 *   - The React hook (useState/useEffect) and the App.tsx rendering gate require
 *     jsdom + @testing-library/react, which are not wired up for dashboard-v2 in this
 *     project's jest config (testEnvironment: 'node'). This matches the precedent in
 *     tests/dashboard/useTheme.test.ts:10-12 and useEventStream.test.ts:3-5.
 *   - Hook-level and component-level coverage should be added when jsdom is configured.
 */

import { formatFetchError } from '../../packages/dashboard-v2/src/lib/fetchError';

describe('formatFetchError — endpoint error labeling (issue #547 regression)', () => {
  it('formats HTTP 500 errors with endpoint name', () => {
    expect(formatFetchError('overview', 'API error: 500')).toBe('overview: HTTP 500');
  });

  it('formats HTTP 503 errors with endpoint name', () => {
    expect(formatFetchError('consensus', 'API error: 503')).toBe('consensus: HTTP 503');
  });

  it('formats HTTP 404 errors with endpoint name', () => {
    expect(formatFetchError('agents', 'API error: 404')).toBe('agents: HTTP 404');
  });

  it('passes through network errors verbatim after endpoint name', () => {
    expect(formatFetchError('overview', 'Failed to fetch')).toBe('overview: Failed to fetch');
  });

  it('passes through "unauthorized" verbatim (api() throws this on 401)', () => {
    // api() throws Error('unauthorized') specifically for 401 — NOT 'API error: 401'
    expect(formatFetchError('overview', 'unauthorized')).toBe('overview: unauthorized');
  });

  it('passes through JSON parse errors verbatim after endpoint name', () => {
    expect(formatFetchError('tasks', 'Unexpected token < in JSON at position 0')).toBe(
      'tasks: Unexpected token < in JSON at position 0',
    );
  });

  it('does NOT mistake non-standard error strings for HTTP status', () => {
    // "API error: " prefix is load-bearing — partial matches must not trigger.
    expect(formatFetchError('consensus', 'API error')).toBe('consensus: API error');
    expect(formatFetchError('consensus', 'API error: abc')).toBe('consensus: API error: abc');
  });

  // Validates that the error message pattern produced by namedFetch gives users
  // actionable context: "<endpoint>: <detail>" so they can identify WHICH fetch
  // is failing from the dashboard error card without opening DevTools.
  it('message is in the "<endpoint>: <detail>" format that the App.tsx error card displays', () => {
    const msg = formatFetchError('overview', 'API error: 500');
    expect(msg).toMatch(/^overview: /);
    expect(msg).toContain('HTTP 500');
  });
});

describe('recovery contract (documented, not mechanically testable in node env)', () => {
  // This describe block documents the recovery behavior that IS implemented but
  // cannot be exercised without jsdom. It serves as a specification anchor —
  // when jsdom is added, these should become real renderHook tests.

  it.todo(
    'hook recovery: after a failing poll, a successful subsequent poll clears error and populates data',
  );

  it.todo(
    'gate test: when error is set and overview is null, App.tsx renders the error message, not "Loading dashboard..."',
  );
});
