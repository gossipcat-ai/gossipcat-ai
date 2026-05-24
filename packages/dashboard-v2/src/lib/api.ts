const BASE = '/dashboard/api';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    credentials: 'include',
    ...options,
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
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
