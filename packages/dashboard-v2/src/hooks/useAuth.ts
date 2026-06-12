import { useState, useEffect, useCallback, useRef } from 'react';
import { checkAuth, login as apiLogin } from '@/lib/api';

export type AuthError = 'bad_key' | 'network' | 'no_cookie' | null;

/**
 * Read `?key=<key>` from the current URL exactly once, then strip it from the
 * address bar + history entry via replaceState (issue #548 item 2). Returns the
 * key if present so the SPA can auto-login with it; the URL is scrubbed
 * regardless so the secret never lingers in history or gets copy-pasted.
 */
function consumeKeyFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const key = params.get('key');
  if (key === null) return null;

  params.delete('key');
  const qs = params.toString();
  const scrubbed = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
  window.history.replaceState(null, '', scrubbed);

  return key.trim() || null;
}

export function useAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [error, setError] = useState<AuthError>(null);
  // Guard: true while any auth check is in flight (mount IIFE or recheck).
  // Prevents recheck from racing the mount-time async IIFE — both call
  // checkAuth concurrently and the last setAuthed wins non-deterministically.
  const checkInFlight = useRef<boolean>(false);

  const login = useCallback(async (key: string): Promise<void> => {
    setError(null);
    const result = await apiLogin(key);
    if (result.ok) {
      setAuthed(true);
    } else {
      setError(result.kind);
      setAuthed(false);
    }
  }, []);

  /**
   * Re-verify the session against the relay. Wired to data-layer 401s (issue
   * #548 item 3b): when a fetch 401s (e.g. the relay restarted and the session
   * is gone), this lands the user back at AuthGate instead of an error card or
   * infinite spinner.
   *
   * Returns current `authed` value immediately (without a new fetch) when
   * another check is already in flight, preventing a race with the mount-time
   * async IIFE.
   */
  const recheck = useCallback(async (): Promise<boolean> => {
    if (checkInFlight.current) {
      // A check is already running — return the current state rather than
      // kicking off a concurrent fetch that could clobber the result.
      return authed === true;
    }
    checkInFlight.current = true;
    try {
      const ok = await checkAuth();
      setAuthed(ok);
      return ok;
    } finally {
      checkInFlight.current = false;
    }
  }, [authed]);

  useEffect(() => {
    let cancelled = false;
    const urlKey = consumeKeyFromUrl();

    checkInFlight.current = true;
    (async () => {
      try {
        // 1. If we already have a working session cookie, use it.
        if (await checkAuth()) {
          if (!cancelled) setAuthed(true);
          return;
        }
        // 2. Otherwise, if the URL carried a ?key=, auto-login with it.
        if (urlKey) {
          if (!cancelled) await login(urlKey);
          return;
        }
        // 3. No session, no key — fall through to the AuthGate login form.
        if (!cancelled) setAuthed(false);
      } finally {
        checkInFlight.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [login]);

  return { authed, login, error, recheck };
}
