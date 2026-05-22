import { useEffect, useState } from 'react';

// Local declaration of the tiny `window` surface this module touches.
// The dashboard-v2 package's own tsconfig pulls in lib.dom; this guard keeps the
// file compilable when ts-jest (root tsconfig, lib.dom NOT included) loads it.
declare const window: {
  localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
  matchMedia?: (query: string) => { matches: boolean };
} | undefined;

declare const document: {
  documentElement: { dataset: Record<string, string> };
} | undefined;

export type Theme = 'light' | 'dark';

export const STORAGE_KEY = 'dashboard:theme';

const KNOWN_THEMES: Theme[] = ['light', 'dark'];

/**
 * Pure: map a raw localStorage value to a Theme, or null if unknown.
 * The legacy union ('default' | 'editorial') is translated:
 *   - 'editorial' (light-cream) → 'light'
 *   - 'default'  (dark)         → 'dark'
 * Any other value yields null so the caller can fall back to prefers-color-scheme.
 */
export function migrateLegacyTheme(raw: string | null): Theme | null {
  if (raw === 'light' || raw === 'dark') return raw;
  if (raw === 'editorial') return 'light';
  if (raw === 'default') return 'dark';
  return null;
}

/**
 * Sanitize an unknown localStorage value to a valid Theme.
 * Falls back to prefersDark when no recognisable value is stored.
 */
export function parseTheme(raw: string | null, prefersDark: boolean): Theme {
  const migrated = migrateLegacyTheme(raw);
  if (migrated !== null) return migrated;
  return prefersDark ? 'dark' : 'light';
}

function readPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true; // SSR / no-MQ env defaults to dark per spec
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const theme = parseTheme(raw, readPrefersDark());
  // One-time migration: rewrite stored value to the new union so subsequent reads are stable.
  if (raw !== theme) {
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch { /* private browsing */ }
  }
  return theme;
}

/**
 * Hook that persists the active theme to localStorage and writes
 * `document.documentElement.dataset.theme` so CSS `[data-theme="dark"]`
 * selectors activate. `light` is the implicit default (no attribute set).
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (theme === 'light') {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  function setTheme(t: Theme): void {
    if (!KNOWN_THEMES.includes(t)) return;
    setThemeState(t);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(STORAGE_KEY, t); } catch { /* private browsing or quota — UI still updates */ }
    }
  }

  const toggle = (): void => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  };

  return { theme, setTheme, toggle };
}
