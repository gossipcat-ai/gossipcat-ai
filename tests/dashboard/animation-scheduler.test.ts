/**
 * Unit tests for the shared AnimationScheduler singleton. The scheduler runs
 * ONE requestAnimationFrame loop and broadcasts ticks to N subscribers.
 *
 * Test environment: jsdom does not implement rAF natively. We stub it with
 * a manual driver so we can advance time deterministically.
 */

import {
  subscribe,
  getSubscriberCount,
  __resetForTests,
} from '../../packages/dashboard-v2/src/lib/animation-scheduler';

type RafCallback = (time: number) => void;
let rafCallbacks: Array<{ id: number; cb: RafCallback }>;
let rafNextId: number;
let now: number;

beforeEach(() => {
  rafCallbacks = [];
  rafNextId = 1;
  now = 1000;
  (globalThis as unknown as { requestAnimationFrame: (cb: RafCallback) => number }).requestAnimationFrame =
    (cb: RafCallback) => {
      const id = rafNextId++;
      rafCallbacks.push({ id, cb });
      return id;
    };
  (globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame =
    (id: number) => {
      rafCallbacks = rafCallbacks.filter((r) => r.id !== id);
    };
  // Default: prefers-reduced-motion off. Individual tests override.
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  });
  __resetForTests();
});

/** Drive one rAF tick at `now`. */
function tick(advanceMs = 16): void {
  now += advanceMs;
  const callbacks = rafCallbacks.slice();
  rafCallbacks = [];
  for (const { cb } of callbacks) cb(now);
}

describe('AnimationScheduler — lifecycle', () => {
  it('starts no rAF loop when no subscribers exist', () => {
    expect(getSubscriberCount()).toBe(0);
    expect(rafCallbacks.length).toBe(0);
  });

  it('starts the rAF loop on the first subscribe', () => {
    subscribe(() => {});
    expect(getSubscriberCount()).toBe(1);
    expect(rafCallbacks.length).toBe(1);
  });

  it('does NOT start a second rAF loop on the second subscribe', () => {
    subscribe(() => {});
    subscribe(() => {});
    expect(getSubscriberCount()).toBe(2);
    // Only one outstanding rAF — the loop schedules its NEXT frame each tick.
    expect(rafCallbacks.length).toBe(1);
  });

  it('stops the rAF loop when the last subscriber unsubscribes', () => {
    const off = subscribe(() => {});
    expect(rafCallbacks.length).toBe(1);
    off();
    expect(getSubscriberCount()).toBe(0);
    // After cancelAnimationFrame, no outstanding rAF remains.
    expect(rafCallbacks.length).toBe(0);
  });

  it('returns an idempotent unsubscribe (safe to call twice)', () => {
    const off = subscribe(() => {});
    off();
    expect(() => off()).not.toThrow();
    expect(getSubscriberCount()).toBe(0);
  });
});

describe('AnimationScheduler — broadcast', () => {
  it('invokes every subscriber on each tick', () => {
    const a = jest.fn();
    const b = jest.fn();
    subscribe(a);
    subscribe(b);
    tick();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('passes the delta-time in milliseconds to each subscriber', () => {
    const cb = jest.fn();
    subscribe(cb);
    tick(16);
    const firstDelta = cb.mock.calls[0][0] as number;
    expect(firstDelta).toBeGreaterThan(0);
    expect(firstDelta).toBeLessThanOrEqual(20);
  });

  it('continues to the next subscriber when one throws', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = jest.fn(() => { throw new Error('boom'); });
    const recovering = jest.fn();
    subscribe(throwing);
    subscribe(recovering);
    tick();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(recovering).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('preserves subscriber insertion order across ticks', () => {
    const order: string[] = [];
    subscribe(() => order.push('a'));
    subscribe(() => order.push('b'));
    subscribe(() => order.push('c'));
    tick();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('schedules a new rAF after each tick (loop is recurring)', () => {
    subscribe(() => {});
    expect(rafCallbacks.length).toBe(1);
    tick();
    expect(rafCallbacks.length).toBe(1); // a new rAF was queued for the next frame
  });
});

describe('AnimationScheduler — prefers-reduced-motion', () => {
  beforeEach(() => {
    (globalThis as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
      matches: q === '(prefers-reduced-motion: reduce)',
      media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
    });
    __resetForTests();
  });

  it('returns a noop unsubscribe and never adds the subscriber', () => {
    const cb = jest.fn();
    const off = subscribe(cb);
    expect(getSubscriberCount()).toBe(0);
    expect(rafCallbacks.length).toBe(0);
    off(); // safe to call
    tick(); // even if some other rAF runs, our cb never fires
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('AnimationScheduler — SSR safety', () => {
  it('returns noop unsubscribe in SSR (no requestAnimationFrame)', () => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    const originalRaf = g.requestAnimationFrame;
    delete g.requestAnimationFrame;
    try {
      const cb = jest.fn();
      const off = subscribe(cb);
      expect(getSubscriberCount()).toBe(0);
      off();
    } finally {
      g.requestAnimationFrame = originalRaf;
    }
  });
});

describe('AnimationScheduler — delta cap (tab-resume safety)', () => {
  it('caps deltaMs at 100ms even when wall-clock advances seconds (tab background → resume)', () => {
    const cb = jest.fn();
    subscribe(cb);
    // First tick establishes lastTickMs and uses the 16ms fallback.
    tick(16);
    expect(cb.mock.calls[0][0]).toBeLessThanOrEqual(16);
    cb.mockClear();
    // Simulate a 5-second tab-background gap.
    tick(5000);
    const observedDelta = cb.mock.calls[0][0] as number;
    expect(observedDelta).toBeLessThanOrEqual(100);
    expect(observedDelta).toBeGreaterThan(0);
  });

  it('does NOT cap normal frame deltas under 100ms', () => {
    const cb = jest.fn();
    subscribe(cb);
    tick(16);
    cb.mockClear();
    tick(33); // 30fps frame
    expect(cb.mock.calls[0][0]).toBeGreaterThanOrEqual(33);
    expect(cb.mock.calls[0][0]).toBeLessThanOrEqual(40);
  });
});

describe('AnimationScheduler — late-cleanup safety', () => {
  it('unsubscribe is safe to call after __resetForTests forcibly clears state', () => {
    const off = subscribe(() => {});
    __resetForTests();
    expect(getSubscriberCount()).toBe(0);
    // unsubscribe captured the closure before reset; should not throw or
    // re-cancel an already-stopped loop.
    expect(() => off()).not.toThrow();
    expect(getSubscriberCount()).toBe(0);
  });
});
