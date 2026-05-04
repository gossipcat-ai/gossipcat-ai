/**
 * Spec: docs/specs/2026-05-04-overview-route-design.md (gitignored — refer by path).
 *
 * Covers the pure-logic side of `useExpert`:
 *   - expertFromSearch returns false when the `expert` query param is absent
 *   - expertFromSearch returns true only when expert=1 (strict equality)
 *   - readExpert is null-safe when window is undefined (SSR / node)
 *
 * The React-hook side (subscribing to `dashboard:navigate` and re-rendering)
 * needs jsdom + @testing-library/react which are not yet wired up for
 * dashboard-v2. That harness arrives in a follow-up PR; for now the static
 * URL-parse logic — the part most likely to silently regress — is covered.
 */

import { expertFromSearch, readExpert } from '../../packages/dashboard-v2/src/lib/useExpert';

describe('expertFromSearch', () => {
  it('returns false when the search string is empty', () => {
    expect(expertFromSearch('')).toBe(false);
  });

  it('returns false when expert is absent', () => {
    expect(expertFromSearch('?foo=bar')).toBe(false);
  });

  it('returns true when expert=1', () => {
    expect(expertFromSearch('?expert=1')).toBe(true);
  });

  it('returns true when expert=1 alongside other params', () => {
    expect(expertFromSearch('?foo=bar&expert=1&baz=qux')).toBe(true);
  });

  it('returns false for non-1 values (strict equality with "1")', () => {
    expect(expertFromSearch('?expert=0')).toBe(false);
    expect(expertFromSearch('?expert=true')).toBe(false);
    expect(expertFromSearch('?expert=')).toBe(false);
  });
});

describe('readExpert', () => {
  it('returns false when window is undefined (SSR / node-only context)', () => {
    // Default jest test env is node, so window is undefined here.
    expect(readExpert()).toBe(false);
  });
});
