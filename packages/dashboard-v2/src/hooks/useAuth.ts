import { useState, useEffect, useCallback } from 'react';
import { checkAuth, login as apiLogin } from '@/lib/api';

export type AuthError = 'bad_key' | 'network' | null;

export function useAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [error, setError] = useState<AuthError>(null);

  useEffect(() => {
    checkAuth().then(setAuthed);
  }, []);

  const login = useCallback(async (key: string) => {
    setError(null);
    const result = await apiLogin(key);
    if (result.ok) {
      setAuthed(true);
    } else {
      setError(result.kind);
    }
  }, []);

  return { authed, login, error };
}
