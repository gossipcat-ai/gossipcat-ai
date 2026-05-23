/**
 * Covers the pure-logic helpers in `useTheme`:
 *   - parseTheme returns prefers-color-scheme default for null
 *   - parseTheme returns 'light' for the 'light' string
 *   - parseTheme returns 'dark' for the 'dark' string
 *   - parseTheme migrates 'editorial' → 'light', 'default' → 'dark'
 *   - parseTheme falls back to prefers-color-scheme for unrecognised strings
 *   - STORAGE_KEY constant equals 'dashboard:theme'
 *
 * The React-hook side needs jsdom + @testing-library/react which are not yet
 * wired up for dashboard-v2. Precedent: tests/dashboard/useExpert.test.ts:9-13.
 */

import { parseTheme, STORAGE_KEY } from '../../packages/dashboard-v2/src/lib/useTheme';

describe('parseTheme', () => {
  it('returns the prefers-color-scheme default when raw is null', () => {
    expect(parseTheme(null, true)).toBe('dark');
    expect(parseTheme(null, false)).toBe('light');
  });

  it('returns "light" when raw is "light"', () => {
    expect(parseTheme('light', true)).toBe('light');
  });

  it('returns "dark" when raw is "dark"', () => {
    expect(parseTheme('dark', false)).toBe('dark');
  });

  it('migrates legacy "editorial" → "light"', () => {
    expect(parseTheme('editorial', true)).toBe('light');
  });

  it('migrates legacy "default" → "dark"', () => {
    expect(parseTheme('default', false)).toBe('dark');
  });

  it('falls back to prefers-color-scheme for an unrecognised string', () => {
    expect(parseTheme('garbage', true)).toBe('dark');
    expect(parseTheme('garbage', false)).toBe('light');
  });
});

describe('STORAGE_KEY', () => {
  it('equals "dashboard:theme"', () => {
    expect(STORAGE_KEY).toBe('dashboard:theme');
  });
});
