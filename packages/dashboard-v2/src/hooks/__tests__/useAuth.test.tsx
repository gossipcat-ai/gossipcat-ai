import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { consumeKeyFromUrl, useAuth } from '../useAuth';

// ---------------------------------------------------------------------------
// Mock @/lib/api — the only external dep useAuth calls
// ---------------------------------------------------------------------------
vi.mock('@/lib/api', () => ({
  checkAuth: vi.fn(),
  login: vi.fn(),
}));

import { checkAuth, login as apiLogin } from '@/lib/api';
const mockCheckAuth = checkAuth as ReturnType<typeof vi.fn>;
const mockApiLogin = apiLogin as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setUrl(search: string, hash = '') {
  Object.defineProperty(window, 'location', {
    value: {
      pathname: '/dashboard/',
      search,
      hash,
    },
    writable: true,
    configurable: true,
  });
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// consumeKeyFromUrl — direct unit tests (no hook needed)
// ---------------------------------------------------------------------------
describe('consumeKeyFromUrl', () => {
  beforeEach(() => {
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the key and scrubs ?key= from the URL', () => {
    setUrl('?key=abc123');
    const key = consumeKeyFromUrl();
    expect(key).toBe('abc123');
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/dashboard/');
  });

  it('preserves other query params and the hash while scrubbing key', () => {
    setUrl('?key=abc&foo=bar', '#section');
    const key = consumeKeyFromUrl();
    expect(key).toBe('abc');
    const replacedUrl = (window.history.replaceState as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(replacedUrl).toContain('foo=bar');
    expect(replacedUrl).not.toContain('key=');
    expect(replacedUrl).toContain('#section');
  });

  it('returns null (but still calls replaceState) for a whitespace-only key', () => {
    setUrl('?key=   ');
    const key = consumeKeyFromUrl();
    expect(key).toBeNull();
    expect(window.history.replaceState).toHaveBeenCalled();
  });

  it('returns null and does NOT call replaceState when no key param is present', () => {
    setUrl('?foo=bar');
    const key = consumeKeyFromUrl();
    expect(key).toBeNull();
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it('returns null when the search string is empty', () => {
    setUrl('');
    const key = consumeKeyFromUrl();
    expect(key).toBeNull();
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// useAuth — mount flow tests
// ---------------------------------------------------------------------------
describe('useAuth — mount flow', () => {
  beforeEach(() => {
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    // default: no ?key= in URL
    setUrl('');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('(a) checkAuth resolves true → authed=true, login NOT called', async () => {
    mockCheckAuth.mockResolvedValue(true);

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.authed).toBe(true));
    expect(mockApiLogin).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('(b) checkAuth false + URL key present → apiLogin called with the key', async () => {
    setUrl('?key=mykey');
    mockCheckAuth.mockResolvedValue(false);
    mockApiLogin.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.authed).toBe(true));
    expect(mockApiLogin).toHaveBeenCalledWith('mykey');
  });

  it('(c) checkAuth false, no key → authed=false', async () => {
    setUrl('');
    mockCheckAuth.mockResolvedValue(false);

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.authed).toBe(false));
    expect(mockApiLogin).not.toHaveBeenCalled();
  });

  it('(d) failed login sets error to the result kind and authed=false', async () => {
    setUrl('?key=badkey');
    mockCheckAuth.mockResolvedValue(false);
    mockApiLogin.mockResolvedValue({ ok: false, kind: 'bad_key' });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.authed).toBe(false));
    expect(result.current.error).toBe('bad_key');
  });
});

// ---------------------------------------------------------------------------
// useAuth — recheck / 401 recovery
// ---------------------------------------------------------------------------
describe('useAuth — recheck', () => {
  beforeEach(() => {
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    setUrl('');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('recheck() calls checkAuth and updates authed (true → false when session is gone)', async () => {
    // Mount with auth passing
    mockCheckAuth.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    // Session expires
    mockCheckAuth.mockResolvedValueOnce(false);
    let recheckResult!: boolean;
    await act(async () => {
      recheckResult = await result.current.recheck();
    });

    expect(recheckResult).toBe(false);
    expect(result.current.authed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useAuth — in-flight guard (prevents duplicate checkAuth calls)
// ---------------------------------------------------------------------------
describe('useAuth — in-flight guard', () => {
  beforeEach(() => {
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    setUrl('');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('concurrent recheck() returns current authed without a second checkAuth call', async () => {
    // Start with authed=true so the in-flight guard has a definitive value to return.
    mockCheckAuth.mockResolvedValueOnce(true);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    // Clear call count after mount settles
    mockCheckAuth.mockClear();

    // Now make recheck hold in-flight using a deferred promise
    const deferred = makeDeferred<boolean>();
    mockCheckAuth.mockReturnValueOnce(deferred.promise);

    // First recheck — this sets checkInFlight.current = true
    let firstResult!: Promise<boolean>;
    act(() => {
      firstResult = result.current.recheck();
    });

    // Second recheck fires while first is still in flight
    let secondResult!: boolean;
    await act(async () => {
      secondResult = await result.current.recheck();
    });

    // The second call must return immediately with current authed (true) without
    // issuing a new checkAuth
    expect(secondResult).toBe(true);
    // Only 1 checkAuth call should have been made (the first recheck)
    expect(mockCheckAuth).toHaveBeenCalledTimes(1);

    // Resolve the deferred so the hook settles cleanly (inside act — the
    // resolution triggers a setAuthed state update)
    await act(async () => {
      deferred.resolve(true);
      await firstResult;
    });
  });
});

// ---------------------------------------------------------------------------
// useAuth — unmount cancellation
// ---------------------------------------------------------------------------
describe('useAuth — unmount cancellation', () => {
  beforeEach(() => {
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    setUrl('');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('does not set state after unmount (no act() warnings)', async () => {
    const deferred = makeDeferred<boolean>();
    mockCheckAuth.mockReturnValue(deferred.promise);

    const { unmount } = renderHook(() => useAuth());

    // Unmount before the promise resolves — the cancelled flag path fires
    unmount();

    // Resolve after unmount — must not trigger any state update or act() warning
    deferred.resolve(true);
    // Small drain to let microtasks flush
    await new Promise((r) => setTimeout(r, 20));
    // If we get here without act() warnings logged the test passes
  });
});
