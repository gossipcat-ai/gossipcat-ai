import { useEffect, useState } from 'react';

// Local declaration of the tiny `window` surface this module touches.
// The dashboard-v2 package's own tsconfig pulls in lib.dom; this guard keeps the
// file compilable when ts-jest (root tsconfig, lib.dom NOT included) loads it.
declare const window: {
  localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
} | undefined;

declare const document: {
  documentElement: { dataset: Record<string, string> };
} | undefined;

export type Theme = 'default' | 'editorial';

export const STORAGE_KEY = 'dashboard:theme';

const KNOWN_THEMES: Theme[] = ['default', 'editorial'];

/**
 * Sanitize an unknown localStorage value to a valid Theme.
 * Unknown / null values fall back to 'default'.
 */
export function parseTheme(raw: string | null): Theme {
  if (raw !== null && (KNOWN_THEMES as string[]).includes(raw)) {
    return raw as Theme;
  }
  return 'default';
}

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'default';
  return parseTheme(window.localStorage.getItem(STORAGE_KEY));
}

/**
 * Hook that persists the active theme to localStorage and writes
 * `document.documentElement.dataset.theme` so CSS `[data-theme="editorial"]`
 * selectors activate.
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (theme === 'default') {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  function setTheme(t: Theme): void {
    setThemeState(t);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, t);
      } catch { /* private browsing or quota — UI still updates */ }
    }
  }

  const toggle = () => {
    setTheme(theme === 'default' ? 'editorial' : 'default');
  };

  return { theme, setTheme, toggle };
}
