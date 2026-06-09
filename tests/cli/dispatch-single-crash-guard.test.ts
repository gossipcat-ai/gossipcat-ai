/**
 * Issue #522 SEV-1 crash guard.
 *
 * handleDispatchSingle's relay path used to destructure `{ taskId }` from
 * mainAgent.dispatch() and DROP the returned finalResultPromise. When a worker
 * provider errored (e.g. an OpenAI 401 from a misconfigured DeepSeek agent),
 * that detached promise rejected with no .catch attached → Node emitted an
 * unhandledRejection → the MCP server tore down and the host respawned it
 * (crash-loop).
 *
 * The fix captures finalResultPromise and attaches `.catch(() => {})` so the
 * background rejection is swallowed at the handler. Task errors still surface to
 * the caller via gossip_collect / gossip_progress.
 *
 * These tests exercise the relay (non-native) path: the agent is intentionally
 * NOT registered in ctx.nativeAgentConfigs, so the native short-circuit above
 * line ~580 is skipped and execution reaches the dispatch() call at ~785.
 */

import { ctx } from '../../apps/cli/src/mcp-context';
import { handleDispatchSingle } from '../../apps/cli/src/handlers/dispatch';

function makeMainAgent(overrides: Record<string, any> = {}): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'default-task-id' }),
    scopeTracker: {
      hasOverlap: jest.fn().mockReturnValue({ overlaps: false }),
      register: jest.fn(),
      release: jest.fn(),
    },
    getSkillIndex: jest.fn().mockReturnValue(null),
    projectRoot: '/tmp/gossip-test-project',
    ...overrides,
  };
}

const originalCtx = {
  mainAgent: ctx.mainAgent,
  nativeAgentConfigs: ctx.nativeAgentConfigs,
  booted: ctx.booted,
  boot: ctx.boot,
  syncWorkersViaKeychain: ctx.syncWorkersViaKeychain,
};

function resetCtx(mainAgentOverrides: Record<string, any> = {}) {
  ctx.mainAgent = makeMainAgent(mainAgentOverrides);
  ctx.nativeAgentConfigs = new Map(); // relay path: agent is NOT native
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
  ctx.syncWorkersViaKeychain = jest.fn().mockResolvedValue(undefined) as any;
}

describe('handleDispatchSingle — #522 background-rejection crash guard', () => {
  afterEach(() => {
    Object.assign(ctx, originalCtx);
  });

  it('attaches a catch so a rejecting finalResultPromise does not unhandled-reject', async () => {
    // dispatch() returns a promise that rejects (simulating a worker provider
    // 401). The handler must attach .catch so this never becomes an
    // unhandledRejection. We register a one-shot listener that fails the test if
    // the rejection escapes.
    const rejecting = Promise.reject(new Error('OpenAI authentication failed (HTTP 401)'));
    const dispatch = jest.fn().mockReturnValue({ taskId: 'tid-401', finalResultPromise: rejecting });

    let escaped: unknown;
    const onUnhandled = (reason: unknown) => { escaped = reason; };
    process.on('unhandledRejection', onUnhandled);

    try {
      resetCtx({ dispatch });
      const result = await handleDispatchSingle('relay-agent', 'do work');
      // The handler returns its normal "Dispatched" envelope even though the
      // background task will reject.
      expect(result.content[0].text).toContain('Dispatched to relay-agent');
      expect(dispatch).toHaveBeenCalledTimes(1);

      // Let microtasks + the rejection-detection turn flush.
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      expect(escaped).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('returns the normal envelope when dispatch resolves (no regression)', async () => {
    const dispatch = jest.fn().mockReturnValue({
      taskId: 'tid-ok',
      finalResultPromise: Promise.resolve({ result: 'ok' }),
    });
    resetCtx({ dispatch });

    const result = await handleDispatchSingle('relay-agent', 'do work');
    expect(result.content[0].text).toContain('Dispatched to relay-agent');
  });

  it('tolerates a dispatch() that returns no finalResultPromise (optional chaining)', async () => {
    // Legacy/mock shape — handler must not throw on a missing finalResultPromise.
    const dispatch = jest.fn().mockReturnValue({ taskId: 'tid-legacy' });
    resetCtx({ dispatch });

    const result = await handleDispatchSingle('relay-agent', 'do work');
    expect(result.content[0].text).toContain('Dispatched to relay-agent');
  });
});
