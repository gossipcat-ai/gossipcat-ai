/**
 * Shared animation scheduler — runs ONE requestAnimationFrame loop and
 * broadcasts ticks to N subscribers. Replaces N independent rAF loops
 * (one per NeuralAvatar) with a single coordinated frame budget, which
 * matters once Phase 1b's AgentNetworkGraph runs d3-force ticks alongside
 * 7+ NeuralAvatar canvases.
 *
 * Contract:
 *   - subscribe(cb) returns an unsubscribe function.
 *   - The loop starts on 0 → 1 subscriber count, stops on 1 → 0.
 *   - One bad subscriber (throws) does NOT kill the loop; error logged.
 *   - prefers-reduced-motion: reduce → subscribe is a noop, callback never runs.
 *   - SSR-safe: no requestAnimationFrame → noop.
 *
 * See spec docs/superpowers/specs/2026-05-22-dashboard-redesign-phase1b-agent-network-graph-design.md
 *   §"3. Performance budget — shared rAF scheduler + idle-pause".
 */

export type AnimationTick = (deltaMs: number) => void;

// Use globalThis throughout so this module compiles under tsconfig targets
// that don't include the DOM lib (e.g. the root tsconfig used by jest).
const g = globalThis as unknown as {
  requestAnimationFrame?: (cb: (nowMs: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  matchMedia?: (q: string) => { matches: boolean };
};

const subscribers = new Set<AnimationTick>();
let rafId = 0;
let lastTickMs = 0;

/**
 * Cap deltaMs at 100ms. When a browser tab backgrounds and resumes, rAF
 * fires with `nowMs` potentially seconds ahead of `lastTickMs`. Subscribers
 * that accumulate this delta into their own state (e.g. VortexEngine's
 * `time += dt`) would otherwise snap animations forward by the full gap
 * in one frame, causing visible particle teleportation. 100ms = ~6 frames
 * at 60Hz, generous enough that a normal frame hiccup doesn't trip it.
 */
const MAX_DELTA_MS = 100;

function loop(nowMs: number): void {
  const deltaMs = lastTickMs === 0
    ? 16
    : Math.min(MAX_DELTA_MS, Math.max(0, nowMs - lastTickMs));
  lastTickMs = nowMs;

  for (const cb of subscribers) {
    try {
      cb(deltaMs);
    } catch (err) {
      console.error('[AnimationScheduler] subscriber threw, continuing', err);
    }
  }

  if (subscribers.size > 0) {
    rafId = g.requestAnimationFrame!(loop);
  } else {
    rafId = 0;
    lastTickMs = 0;
  }
}

function start(): void {
  if (rafId !== 0) return;
  lastTickMs = 0;
  rafId = g.requestAnimationFrame!(loop);
}

function stop(): void {
  if (rafId === 0) return;
  if (g.cancelAnimationFrame) g.cancelAnimationFrame(rafId);
  rafId = 0;
  lastTickMs = 0;
}

function prefersReducedMotion(): boolean {
  if (!g.matchMedia) return false;
  return g.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function subscribe(cb: AnimationTick): () => void {
  if (!g.requestAnimationFrame) return () => {};
  if (prefersReducedMotion()) return () => {};

  subscribers.add(cb);
  if (subscribers.size === 1) start();

  let unsubscribed = false;
  return function unsubscribe(): void {
    if (unsubscribed) return;
    unsubscribed = true;
    subscribers.delete(cb);
    if (subscribers.size === 0) stop();
  };
}

/** Test-only: number of currently-subscribed callbacks. */
export function getSubscriberCount(): number {
  return subscribers.size;
}

/** Test-only: clear all subscribers and stop the loop. Call in beforeEach. */
export function __resetForTests(): void {
  subscribers.clear();
  stop();
}
