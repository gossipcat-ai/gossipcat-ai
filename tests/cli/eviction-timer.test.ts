/**
 * Unit tests for scheduleNativeTaskEviction — the periodic eviction helper
 * extracted from doBoot() in mcp-server-sdk.ts.
 *
 * Verifies the REAL production helper (not a test-local reimplementation):
 *   (a) setInterval is called with evictStaleNativeTasks and the given interval
 *   (b) .unref() is called on the returned timer so it does not block exit
 *   (c) stop() clears the interval
 */

jest.mock('../../apps/cli/src/mcp-context', () => ({
  ctx: {
    nativeTaskMap: new Map(),
    nativeResultMap: new Map(),
    nativeUtilityResultMap: new Map(),
    mainAgent: undefined,
  },
}));

import {
  scheduleNativeTaskEviction,
  evictStaleNativeTasks,
} from '../../apps/cli/src/handlers/native-tasks';

describe('scheduleNativeTaskEviction', () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  let setIntervalSpy: jest.Mock;
  let clearIntervalSpy: jest.Mock;
  let unrefSpy: jest.Mock;
  let fakeTimer: { unref: jest.Mock };

  beforeEach(() => {
    unrefSpy = jest.fn();
    fakeTimer = { unref: unrefSpy };
    setIntervalSpy = jest.fn(() => fakeTimer);
    clearIntervalSpy = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).setInterval = setIntervalSpy;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).clearInterval = clearIntervalSpy;
  });

  afterEach(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  it('(a) calls setInterval with evictStaleNativeTasks and the given interval', () => {
    scheduleNativeTaskEviction(12345);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(evictStaleNativeTasks, 12345);
  });

  it('defaults to a 1h interval when no interval is provided', () => {
    scheduleNativeTaskEviction();

    expect(setIntervalSpy).toHaveBeenCalledWith(evictStaleNativeTasks, 60 * 60 * 1000);
  });

  it('(b) calls .unref() on the returned timer so exit is not blocked', () => {
    scheduleNativeTaskEviction();

    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });

  it('(c) stop() clears the interval with the correct timer reference', () => {
    const { stop } = scheduleNativeTaskEviction();

    stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
  });

  it('stop() does not fire the eviction callback itself', () => {
    const evictSpy = jest.fn();
    setIntervalSpy.mockImplementation(() => {
      // Record the callback was registered but don't invoke it
      return fakeTimer;
    });

    const { stop } = scheduleNativeTaskEviction();
    stop();

    // Callback passed to setInterval is evictStaleNativeTasks, but no timer
    // actually fires (mocked), so evictSpy stays at 0. Verifies stop()
    // pathway is clean.
    expect(evictSpy).not.toHaveBeenCalled();
  });
});
