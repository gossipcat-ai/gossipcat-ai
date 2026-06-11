const BASE = '/dashboard/api';

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
      signal: timeoutSignal,
      ...options,
    });
    if (res.status === 401) throw new Error('unauthorized');
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

export type LoginResult = { ok: true } | { ok: false; kind: 'bad_key' | 'network' };

export async function login(key: string): Promise<LoginResult> {
  try {
    const res = await fetch(`${BASE}/auth`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'bad_key' };
    return { ok: false, kind: 'network' };
  } catch {
    return { ok: false, kind: 'network' };
  }
}

export async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/overview`, { credentials: 'include' });
    return res.ok;
  } catch {
    return false;
  }
}
