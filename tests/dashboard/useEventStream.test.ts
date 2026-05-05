/**
 * Pure-logic helpers from useEventStream.ts — no jsdom integration required.
 *
 * Follows the precedent of tests/dashboard/useExpert.test.ts:9-13 where only
 * the pure-logic (non-hook) surface is covered in the root jest environment
 * (node, no DOM). The hook itself relies on EventSource + localStorage which
 * are browser APIs.
 */

import { readLastEventId, writeLastEventId } from '../../packages/dashboard-v2/src/lib/useEventStream';

describe('readLastEventId', () => {
  it('returns 0 when window is undefined (node / SSR environment)', () => {
    // Default jest test env is node, so window is undefined here.
    expect(readLastEventId()).toBe(0);
  });
});

describe('writeLastEventId', () => {
  it('is a no-op when window is undefined — does not throw', () => {
    expect(() => writeLastEventId(42)).not.toThrow();
  });
});
