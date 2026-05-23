/**
 * Phase 1a — one-time localStorage migration from the old
 * 'default' | 'editorial' theme union to the new 'light' | 'dark' union.
 *
 * Mirrors the precedent set in useTheme.test.ts (pure-logic only — no React
 * hook, no jsdom). We export `migrateLegacyTheme(raw)` to keep this testable
 * without rendering the hook.
 */

import { migrateLegacyTheme } from '../../packages/dashboard-v2/src/lib/useTheme';

describe('migrateLegacyTheme', () => {
  it('maps the legacy "editorial" value to "light"', () => {
    expect(migrateLegacyTheme('editorial')).toBe('light');
  });

  it('maps the legacy "default" value to "dark"', () => {
    expect(migrateLegacyTheme('default')).toBe('dark');
  });

  it('passes through the new "light" value', () => {
    expect(migrateLegacyTheme('light')).toBe('light');
  });

  it('passes through the new "dark" value', () => {
    expect(migrateLegacyTheme('dark')).toBe('dark');
  });

  it('returns null for unknown values so the caller can fall back to prefers-color-scheme', () => {
    expect(migrateLegacyTheme('garbage')).toBeNull();
    expect(migrateLegacyTheme(null)).toBeNull();
  });
});
