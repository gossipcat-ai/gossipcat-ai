/**
 * Shutdown helper extracted for testability — see consensus 97636615-f9f54441.
 *
 * The CRITICAL invariant: drainLifecycleTasks() must run BEFORE relayStop and
 * exit, so detached lifecycle tasks (e.g. the post-collect skill graduation
 * runner) finish before the WS server tears down and the process dies.
 *
 * Tests pass jest.fn spies as deps and assert call order via
 * mock.invocationCallOrder. If a future refactor drops the await on
 * drainLifecycleTasks(), the order assertion fails loudly.
 */

export interface ShutdownDeps {
  eviction: { stop: () => void };
  relayStop: () => Promise<void>;
  cleanupPid: () => void;
  drainLifecycleTasks: () => Promise<void>;
  exit: (code: number) => void;
  pid: number;
}

export async function shutdownOnSignal(signal: string, deps: ShutdownDeps): Promise<void> {
  try { await deps.drainLifecycleTasks(); } catch { /* never throw from signal handler */ }
  deps.eviction.stop();
  process.stderr.write(`[relay] shutdown reason=${signal} pid=${deps.pid}\n`);
  try { await deps.relayStop(); } catch { /* ignore */ }
  deps.cleanupPid();
  deps.exit(0);
}
