const BASE = '/dashboard/api';

/**
 * Message thrown by api() on an HTTP 401. Exported so the data layer can tell a
 * dead-session 401 apart from a generic fetch failure and trigger an auth
 * re-check (issue #548 item 3b) instead of showing an error card forever.
 */
export const UNAUTHORIZED = 'unauthorized';

/** True if `err` is the 401 sentinel from api(), even after endpoint-wrapping. */
export function isUnauthorizedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(UNAUTHORIZED);
}

/** Default abort timeout for polled api() calls (milliseconds). */
export const API_TIMEOUT_MS = 30_000;

/**
 * Returns a formatted timeout message used both by the abort handler and by
 * tests that verify the message format. Exported so unit tests can assert the
 * exact string that namedFetch will surface in the dashboard error card.
 */
export function timeoutMessage(ms: number): string {
  return `timeout after ${ms / 1000}s`;
}

/**
 * Builds an AbortSignal that fires after `ms` milliseconds.
 * Prefers AbortSignal.timeout() (available in modern browsers + Node ≥17.3)
 * and falls back to a manual AbortController + setTimeout pair.
 */
function makeTimeoutSignal(ms: number): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as { timeout?: unknown }).timeout === 'function') {
    return { signal: (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout(ms), cleanup: () => {} };
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error(timeoutMessage(ms))), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(id),
  };
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const { signal: timeoutSignal, cleanup } = makeTimeoutSignal(API_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${path}`, {
      credentials: 'include',
      ...options,
      // After the spread so a caller-supplied options.signal can never
      // silently disable the timeout (the hang class this guard closes).
      // A future cancellable caller must compose via AbortSignal.any.
      signal: timeoutSignal,
    });
    if (res.status === 401) throw new Error(UNAUTHORIZED);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json() as Promise<T>;
  } catch (err) {
    // Re-map AbortError / TimeoutError from the signal into a human-readable
    // "timeout after Xs" message so namedFetch can label it with the endpoint
    // name and the error card displays e.g. "consensus: timeout after 30s".
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(timeoutMessage(API_TIMEOUT_MS));
    }
    throw err;
  } finally {
    cleanup();
  }
}

export type LoginResult =
  | { ok: true }
  | { ok: false; kind: 'bad_key' | 'network' | 'no_cookie' };

/**
 * POST the key, then immediately verify the session actually works by hitting
 * the authed /auth/check endpoint (issue #548 item 1: fail loudly instead of
 * dismissing AuthGate into an infinite spinner). If the POST returned 200 but
 * the follow-up check 401s, the browser silently dropped the session cookie —
 * surface that as `no_cookie` so the user sees a real error.
 */
export async function login(key: string): Promise<LoginResult> {
  const { signal: timeoutSignal, cleanup } = makeTimeoutSignal(API_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/auth`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: timeoutSignal,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, kind: 'bad_key' };
      return { ok: false, kind: 'network' };
    }
    // Auth POST succeeded — confirm the cookie round-trips before declaring victory.
    const stored = await checkAuth();
    if (!stored) return { ok: false, kind: 'no_cookie' };
    return { ok: true };
  } catch {
    return { ok: false, kind: 'network' };
  } finally {
    cleanup();
  }
}

/**
 * Verify the current session by calling the dedicated /auth/check probe. Used
 * on mount (was a session restored from a persisted cookie?) and right after
 * login (did the browser actually store the cookie?).
 */
export async function checkAuth(): Promise<boolean> {
  const { signal: timeoutSignal, cleanup } = makeTimeoutSignal(API_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/auth/check`, { credentials: 'include', signal: timeoutSignal });
    return res.ok;
  } catch {
    return false;
  } finally {
    cleanup();
  }
}
