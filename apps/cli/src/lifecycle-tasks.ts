/**
 * Lifecycle task tracker — keeps fire-and-forget background promises alive
 * across SIGTERM/SIGINT/beforeExit so we don't drop work like the
 * skill-graduation runner during shutdown.
 *
 * Spec: consensus 4bd62d6c-46fd4e55. Two root causes drive this:
 *   A) collect.ts has an early `return` (two-phase native-prompt path) that
 *      bypasses the setImmediate-detached runner — we now schedule the
 *      runner BEFORE the early return AND register its promise here so
 *      handlers below (B) can drain it.
 *   B) mcp-server-sdk.ts SIGTERM handler calls `process.exit(0)` after
 *      `relay.stop()` — that hard-exits the event loop and any pending
 *      setImmediate callback (and its async work) is dropped on the floor.
 *      `installLifecycleDrainHandlers` runs `drainLifecycleTasks` BEFORE
 *      the existing handler's exit by registering FIRST (handlers fire in
 *      registration order), so the existing handler still runs after.
 */

const inFlight: Set<Promise<void>> = new Set();
let __installed = false;

/**
 * Register a promise so shutdown handlers can wait for it. The promise
 * removes itself from the set on settle (resolve OR reject) — callers
 * still own error handling on the original promise; this just tracks
 * lifetime.
 */
export function trackLifecycleTask(p: Promise<void>): void {
  inFlight.add(p);
  p.finally(() => { inFlight.delete(p); }).catch(() => { /* swallow — caller owns error */ });
}

/**
 * Wait for all tracked promises to settle, capped at `maxMs`. Resolves
 * either when every in-flight task settles or when the timeout elapses,
 * whichever comes first. Never throws.
 */
export function drainLifecycleTasks(maxMs: number = 8000): Promise<void> {
  if (inFlight.size === 0) return Promise.resolve();
  const snapshot = [...inFlight];
  return Promise.race([
    Promise.allSettled(snapshot).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, maxMs).unref?.()),
  ]).then(() => undefined);
}

/**
 * Install SIGTERM/SIGINT/beforeExit drain handlers exactly once. Subsequent
 * calls are no-ops. Handlers CHAIN with whatever else is registered (we use
 * `process.on`, not `process.once`-replace) and run drain BEFORE returning,
 * so the existing handler's `process.exit(0)` only fires after drain
 * resolves.
 *
 * Order matters: this MUST be called BEFORE the existing SIGTERM handler in
 * mcp-server-sdk.ts so node fires us first (handlers run in registration
 * order). The existing handler is `process.once`, so it still runs after
 * us — we just give the runner a chance to finish.
 */
export function installLifecycleDrainHandlers(): void {
  if (__installed) return;
  __installed = true;

  const drainAndContinue = async (signal: string) => {
    try {
      const pending = inFlight.size;
      if (pending > 0) {
        process.stderr.write(`[gossipcat] ${signal}: draining ${pending} lifecycle task(s)\n`);
      }
      await drainLifecycleTasks();
    } catch { /* never throw from a signal handler */ }
  };

  process.on('SIGTERM', () => { void drainAndContinue('SIGTERM'); });
  process.on('SIGINT',  () => { void drainAndContinue('SIGINT'); });
  process.on('beforeExit', () => { void drainAndContinue('beforeExit'); });
}

// Test-only — reset module state. Not exported via index; tests import directly.
export function __resetLifecycleTasksForTests(): void {
  inFlight.clear();
  __installed = false;
}
