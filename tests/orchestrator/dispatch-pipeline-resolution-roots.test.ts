/**
 * Path 1 — relay-worker resolutionRoots plumbing.
 *
 * Spec: docs/specs/2026-04-29-relay-worker-resolution-roots.md.
 *
 * These tests verify the dispatch-pipeline.ts contract:
 *   - assignRoot fires BEFORE worker.executeTask iteration is awaited
 *     (invariant #1, ordering).
 *   - assignRoot is gated on `worker instanceof WorkerAgent`
 *     (invariant #2, native-agent guard).
 *   - missing/non-directory resolutionRoots[0] throws + emits
 *     transport_failure (invariant #3, fail-closed).
 *   - releaseAgent is called on FINAL_RESULT and ERROR paths
 *     (invariant #4, per-agent cleanup).
 *   - Multiple roots: only [0] reaches assignRoot.
 *   - Concurrent rounds (Option B): documented last-write-wins.
 *   - Reconnect mid-round: getRunningTaskRecords carries resolutionRoots.
 *   - Malformed envelope: validator rejects upstream; pipeline tolerates
 *     undefined / empty array.
 */
import { DispatchPipeline, WorkerAgent } from '@gossip/orchestrator';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type CallTrace = { type: 'assignRoot' | 'releaseAgent'; agentId: string; root?: string; at: number };

function mkToolServer() {
  const calls: CallTrace[] = [];
  return {
    assignScope: (_a: string, _s: string) => {},
    assignRoot: (agentId: string, root: string) => {
      calls.push({ type: 'assignRoot', agentId, root, at: Date.now() });
    },
    releaseAgent: (agentId: string) => {
      calls.push({ type: 'releaseAgent', agentId, at: Date.now() });
    },
    _calls: calls,
  };
}

/**
 * Build an object whose prototype IS WorkerAgent.prototype so
 * `worker instanceof WorkerAgent` is true, but whose constructor we
 * skipped (the real one instantiates a real GossipAgent + WebSocket).
 */
function fakeWorkerAgent(impl: {
  executeTask?: () => AsyncGenerator<any, void, undefined>;
}): any {
  const wa: any = Object.create(WorkerAgent.prototype);
  wa.executeTask = impl.executeTask ?? (async function* () {
    yield { type: 'final_result', payload: { result: 'ok', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
  });
  wa.subscribeToBatch = jest.fn().mockResolvedValue(undefined);
  wa.unsubscribeFromBatch = jest.fn().mockResolvedValue(undefined);
  return wa;
}

function plainRelayWorker(opts?: { result?: string }) {
  return {
    executeTask: jest.fn().mockImplementation(async function* () {
      yield {
        type: 'final_result',
        payload: { result: opts?.result ?? 'done', inputTokens: 0, outputTokens: 0 },
        timestamp: Date.now(),
      };
    }),
    subscribeToBatch: jest.fn().mockResolvedValue(undefined),
    unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DispatchPipeline — resolutionRoots → relay tool-call scoping (Path 1)', () => {
  let projectRoot: string;
  let worktree: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'pipe-rr-proj-'));
    worktree = mkdtempSync(join(tmpdir(), 'pipe-rr-wt-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  });

  function buildPipeline(toolServer: ReturnType<typeof mkToolServer>) {
    const workers = new Map<string, any>();
    return {
      workers,
      pipeline: new DispatchPipeline({
        projectRoot,
        workers,
        registryGet: (id) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
        toolServer,
      }),
    };
  }

  // ── Test 3 — non-WorkerAgent worker: assignRoot is NOT called ─────────
  it('Test 3 — non-WorkerAgent worker: assignRoot is NOT called even with resolutionRoots', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    workers.set('plain', plainRelayWorker());
    const { finalResultPromise } = pipeline.dispatch('plain', 'task', { resolutionRoots: [worktree] });
    await finalResultPromise;
    expect(ts._calls.filter(c => c.type === 'assignRoot')).toHaveLength(0);
  });

  // ── Test 1 — assignRoot before executeTask iterates ───────────────────
  it('Test 1 — WorkerAgent + resolutionRoots: assignRoot fires BEFORE executeTask iterates', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    let executeTaskCalledAt: number | null = null;
    const wa = fakeWorkerAgent({
      executeTask: async function* () {
        executeTaskCalledAt = Date.now();
        yield { type: 'final_result', payload: { result: 'ok', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
      },
    });
    workers.set('relay-1', wa);
    const { finalResultPromise } = pipeline.dispatch('relay-1', 'review', { resolutionRoots: [worktree] });
    await finalResultPromise;
    const assigns = ts._calls.filter(c => c.type === 'assignRoot');
    expect(assigns).toHaveLength(1);
    expect(assigns[0].agentId).toBe('relay-1');
    expect(assigns[0].root).toBe(worktree);
    expect(executeTaskCalledAt).not.toBeNull();
    expect(assigns[0].at).toBeLessThanOrEqual(executeTaskCalledAt!);
  });

  // ── Test 2 — no resolutionRoots: pipeline unchanged ───────────────────
  it('Test 2 — no resolutionRoots: assignRoot NOT called', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    workers.set('relay-1', fakeWorkerAgent({}));
    const { finalResultPromise } = pipeline.dispatch('relay-1', 'review');
    await finalResultPromise;
    expect(ts._calls.filter(c => c.type === 'assignRoot')).toHaveLength(0);
  });

  // ── Test 4 — fail-closed on missing path ──────────────────────────────
  it('Test 4 — non-existent worktree path: dispatch fails closed (no assignRoot)', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    workers.set('relay-1', fakeWorkerAgent({}));
    const ghost = join(tmpdir(), 'pipe-rr-deleted-' + Date.now());
    expect(existsSync(ghost)).toBe(false);
    const { finalResultPromise } = pipeline.dispatch('relay-1', 'review', { resolutionRoots: [ghost] });
    await expect(finalResultPromise).rejects.toThrow(/does not exist or is not a directory/);
    expect(ts._calls.filter(c => c.type === 'assignRoot')).toHaveLength(0);
  });

  // ── Test 5 — multiple roots: only [0] used ─────────────────────────────
  it('Test 5 — multiple resolutionRoots: only [0] reaches assignRoot', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    const wt2 = mkdtempSync(join(tmpdir(), 'pipe-rr-wt2-'));
    try {
      workers.set('relay-1', fakeWorkerAgent({}));
      const { finalResultPromise } = pipeline.dispatch('relay-1', 'review', { resolutionRoots: [worktree, wt2] });
      await finalResultPromise;
      const assigns = ts._calls.filter(c => c.type === 'assignRoot');
      expect(assigns).toHaveLength(1);
      expect(assigns[0].root).toBe(worktree);
    } finally {
      rmSync(wt2, { recursive: true, force: true });
    }
  });

  // ── Test 6 — Option B last-write semantics for concurrent same-agent ─
  it('Test 6 — Option B: concurrent same-agent dispatches both call assignRoot (last-write)', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    const wt2 = mkdtempSync(join(tmpdir(), 'pipe-rr-wt-b-'));
    try {
      workers.set('shared', fakeWorkerAgent({
        executeTask: async function* () {
          await new Promise(r => setTimeout(r, 5));
          yield { type: 'final_result', payload: { result: 'ok', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
        },
      }));
      const r1 = pipeline.dispatch('shared', 'A', { resolutionRoots: [worktree] });
      const r2 = pipeline.dispatch('shared', 'B', { resolutionRoots: [wt2] });
      await Promise.all([r1.finalResultPromise, r2.finalResultPromise]);
      const assigns = ts._calls.filter(c => c.type === 'assignRoot');
      expect(assigns).toHaveLength(2);
      expect(assigns.map(a => a.root).sort()).toEqual([worktree, wt2].sort());
    } finally {
      rmSync(wt2, { recursive: true, force: true });
    }
  });

  // ── Test 8a — releaseAgent on success ─────────────────────────────────
  it('Test 8a — releaseAgent called after FINAL_RESULT', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    workers.set('relay-1', fakeWorkerAgent({}));
    const { finalResultPromise } = pipeline.dispatch('relay-1', 'review', { resolutionRoots: [worktree] });
    await finalResultPromise;
    const releases = ts._calls.filter(c => c.type === 'releaseAgent' && c.agentId === 'relay-1');
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 8b — releaseAgent on error ───────────────────────────────────
  it('Test 8b — releaseAgent called after ERROR', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    workers.set('relay-1', fakeWorkerAgent({
      executeTask: async function* () {
        yield { type: 'error', payload: { error: 'boom' }, timestamp: Date.now() };
      },
    }));
    const { finalResultPromise } = pipeline.dispatch('relay-1', 'review', { resolutionRoots: [worktree] });
    await finalResultPromise.catch(() => {});
    const releases = ts._calls.filter(c => c.type === 'releaseAgent' && c.agentId === 'relay-1');
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 9 — empty/undefined arrays do not crash the pipeline ──────────
  it('Test 9 — empty resolutionRoots array: no assignRoot, no crash', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    workers.set('relay-1', fakeWorkerAgent({}));
    const { finalResultPromise } = pipeline.dispatch('relay-1', 'review', { resolutionRoots: [] });
    await finalResultPromise;
    expect(ts._calls.filter(c => c.type === 'assignRoot')).toHaveLength(0);
  });

  // ── Test 7 — getRunningTaskRecords carries resolutionRoots ─────────────
  it('Test 7 — getRunningTaskRecords includes resolutionRoots when supplied', async () => {
    const ts = mkToolServer();
    const { workers, pipeline } = buildPipeline(ts);
    let resolveExecute: () => void = () => {};
    const wa = fakeWorkerAgent({
      executeTask: async function* () {
        await new Promise<void>(r => { resolveExecute = r; });
        yield { type: 'final_result', payload: { result: 'ok', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
      },
    });
    workers.set('relay-1', wa);
    const { finalResultPromise } = pipeline.dispatch('relay-1', 'review', { resolutionRoots: [worktree] });
    // Allow runTask() to enter — assignRoot fires synchronously, then
    // worker.executeTask is awaited and our promise blocks.
    await new Promise(r => setImmediate(r));
    const records = pipeline.getRunningTaskRecords();
    expect(records).toHaveLength(1);
    expect(records[0].resolutionRoots).toEqual([worktree]);
    resolveExecute();
    await finalResultPromise.catch(() => {});
  });
});
