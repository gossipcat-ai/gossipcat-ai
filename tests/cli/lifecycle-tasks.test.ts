/**
 * Unit tests for lifecycle-tasks: tracking, draining, idempotent install.
 * Spec: consensus 4bd62d6c-46fd4e55.
 */
import {
  trackLifecycleTask,
  drainLifecycleTasks,
  installLifecycleDrainHandlers,
  __resetLifecycleTasksForTests,
} from '../../apps/cli/src/lifecycle-tasks';

describe('lifecycle-tasks', () => {
  beforeEach(() => {
    __resetLifecycleTasksForTests();
  });

  it('drainLifecycleTasks resolves immediately when nothing is tracked', async () => {
    const start = Date.now();
    await drainLifecycleTasks(5000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('drainLifecycleTasks waits for tracked promises to settle', async () => {
    let resolved = false;
    const p = new Promise<void>((res) => setTimeout(() => { resolved = true; res(); }, 30));
    trackLifecycleTask(p);
    await drainLifecycleTasks(5000);
    expect(resolved).toBe(true);
  });

  it('drainLifecycleTasks tolerates rejected tracked promises', async () => {
    const p = new Promise<void>((_, rej) => setTimeout(() => rej(new Error('boom')), 10));
    trackLifecycleTask(p);
    // Should not throw — drain uses allSettled.
    await expect(drainLifecycleTasks(5000)).resolves.toBeUndefined();
  });

  it('drainLifecycleTasks respects maxMs ceiling on never-settling promise', async () => {
    // Use a promise that NEVER resolves.
    const never = new Promise<void>(() => { /* nothing */ });
    trackLifecycleTask(never);
    const start = Date.now();
    await drainLifecycleTasks(120);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(800);
  });

  it('installLifecycleDrainHandlers is idempotent', () => {
    // Consensus 97636615-f9f54441: SIGTERM/SIGINT drain is now invoked
    // synchronously from mcp-server-sdk.ts's process.once handlers (Option B).
    // This module only registers a beforeExit fallback for non-signal exits.
    const before = process.listenerCount('beforeExit');
    installLifecycleDrainHandlers();
    const afterFirst = process.listenerCount('beforeExit');
    installLifecycleDrainHandlers();
    installLifecycleDrainHandlers();
    const afterThird = process.listenerCount('beforeExit');
    expect(afterFirst).toBe(before + 1);
    expect(afterThird).toBe(afterFirst);
    // Hard guarantee: NO signal listeners are added by this module anymore.
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('settled promises remove themselves from the in-flight set', async () => {
    let count = 0;
    const p = (async () => { count++; })();
    trackLifecycleTask(p);
    await p;
    // Allow finally microtask to run.
    await Promise.resolve();
    // Subsequent drain should be near-instant — set is empty.
    const start = Date.now();
    await drainLifecycleTasks(5000);
    expect(Date.now() - start).toBeLessThan(50);
    expect(count).toBe(1);
  });
});
