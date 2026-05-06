/**
 * Covers the pure-logic helpers in `useTheme`:
 *   - parseTheme returns 'default' for null
 *   - parseTheme returns 'default' for the 'default' string
 *   - parseTheme returns 'editorial' for the 'editorial' string
 *   - parseTheme returns 'default' for unrecognised strings
 *   - STORAGE_KEY constant equals 'dashboard:theme'
 *
 * The React-hook side needs jsdom + @testing-library/react which are not yet
 * wired up for dashboard-v2. Precedent: tests/dashboard/useExpert.test.ts:9-13.
 */

import { parseTheme, STORAGE_KEY } from '../../packages/dashboard-v2/src/lib/useTheme';

describe('parseTheme', () => {
  it('returns "default" when raw is null', () => {
    expect(parseTheme(null)).toBe('default');
  });

  it('returns "default" when raw is "default"', () => {
    expect(parseTheme('default')).toBe('default');
  });

  it('returns "editorial" when raw is "editorial"', () => {
    expect(parseTheme('editorial')).toBe('editorial');
  });

  it('returns "default" for an unrecognised string', () => {
    expect(parseTheme('garbage')).toBe('default');
  });
});

describe('STORAGE_KEY', () => {
  it('equals "dashboard:theme"', () => {
    expect(STORAGE_KEY).toBe('dashboard:theme');
  });
});
