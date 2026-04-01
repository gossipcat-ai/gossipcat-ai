import { useState, useEffect, useCallback } from 'react';
import { checkAuth, login as apiLogin } from '@/lib/api';

export function useAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    checkAuth().then(setAuthed);
  }, []);

  const login = useCallback(async (key: string) => {
    setError(false);
    const ok = await apiLogin(key);
    if (ok) {
      setAuthed(true);
    } else {
      setError(true);
    }
  }, []);

  return { authed, login, error };
}
