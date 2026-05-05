/**
 * Regression: SIGTERM/SIGINT shutdown drains lifecycle tasks BEFORE
 * eviction.stop / relay.stop / process.exit (consensus 97636615-f9f54441).
 *
 * The bug: prior to this fix the drain handler ran asynchronously alongside
 * the once-style SIGTERM handler that immediately called relay.stop() +
 * process.exit(0). That truncated the post-collect skill graduation runner
 * mid-flight on every shutdown.
 *
 * The fix: shutdownOnSignal now awaits drainLifecycleTasks() first. This test
 * pins the call order via jest.fn().mock.invocationCallOrder so a future
 * refactor that re-orders the steps fails loudly.
 */
import { shutdownOnSignal, type ShutdownDeps } from '../../apps/cli/src/shutdown';

describe('shutdownOnSignal — call order', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  function makeDeps(overrides: Partial<ShutdownDeps> = {}): {
    deps: ShutdownDeps;
    drainSpy: jest.Mock;
    evictionStopSpy: jest.Mock;
    relayStopSpy: jest.Mock;
    cleanupPidSpy: jest.Mock;
    exitSpy: jest.Mock;
  } {
    const drainSpy = jest.fn(async () => undefined);
    const evictionStopSpy = jest.fn();
    const relayStopSpy = jest.fn(async () => undefined);
    const cleanupPidSpy = jest.fn();
    const exitSpy = jest.fn();
    const deps: ShutdownDeps = {
      eviction: { stop: evictionStopSpy },
      relayStop: relayStopSpy,
      cleanupPid: cleanupPidSpy,
      drainLifecycleTasks: drainSpy,
      exit: exitSpy,
      pid: 12345,
      ...overrides,
    };
    return { deps, drainSpy, evictionStopSpy, relayStopSpy, cleanupPidSpy, exitSpy };
  }

  it('runs drainLifecycleTasks BEFORE eviction.stop, relay.stop, cleanupPid, and exit', async () => {
    const { deps, drainSpy, evictionStopSpy, relayStopSpy, cleanupPidSpy, exitSpy } = makeDeps();

    await shutdownOnSignal('SIGTERM', deps);

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(evictionStopSpy).toHaveBeenCalledTimes(1);
    expect(relayStopSpy).toHaveBeenCalledTimes(1);
    expect(cleanupPidSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    const drainOrder = drainSpy.mock.invocationCallOrder[0];
    const evictionOrder = evictionStopSpy.mock.invocationCallOrder[0];
    const relayOrder = relayStopSpy.mock.invocationCallOrder[0];
    const cleanupOrder = cleanupPidSpy.mock.invocationCallOrder[0];
    const exitOrder = exitSpy.mock.invocationCallOrder[0];

    // CRITICAL: drain runs before relay teardown — that's the whole point of
    // the fix. If a refactor drops the await on drainLifecycleTasks(), this
    // ordering breaks.
    expect(drainOrder).toBeLessThan(relayOrder);
    expect(drainOrder).toBeLessThan(evictionOrder);
    expect(drainOrder).toBeLessThan(cleanupOrder);
    expect(drainOrder).toBeLessThan(exitOrder);

    // Tail order: eviction → relay → cleanupPid → exit.
    expect(evictionOrder).toBeLessThan(relayOrder);
    expect(relayOrder).toBeLessThan(cleanupOrder);
    expect(cleanupOrder).toBeLessThan(exitOrder);
  });

  it('still proceeds through the remaining steps when drainLifecycleTasks throws', async () => {
    const drainSpy = jest.fn(async () => { throw new Error('boom'); });
    const { deps, evictionStopSpy, relayStopSpy, cleanupPidSpy, exitSpy } = makeDeps({
      drainLifecycleTasks: drainSpy,
    });

    await expect(shutdownOnSignal('SIGINT', deps)).resolves.toBeUndefined();

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(evictionStopSpy).toHaveBeenCalledTimes(1);
    expect(relayStopSpy).toHaveBeenCalledTimes(1);
    expect(cleanupPidSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('still calls cleanupPid + exit when relayStop throws', async () => {
    const relayStopSpy = jest.fn(async () => { throw new Error('relay-stop boom'); });
    const { deps, drainSpy, evictionStopSpy, cleanupPidSpy, exitSpy } = makeDeps({
      relayStop: relayStopSpy,
    });

    await expect(shutdownOnSignal('SIGTERM', deps)).resolves.toBeUndefined();

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(evictionStopSpy).toHaveBeenCalledTimes(1);
    expect(relayStopSpy).toHaveBeenCalledTimes(1);
    expect(cleanupPidSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
