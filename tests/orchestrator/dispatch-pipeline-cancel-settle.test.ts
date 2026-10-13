import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DispatchPipeline } from '../../packages/orchestrator/src/dispatch-pipeline';

/**
 * B8: once cancelRunningTasks()/collect timeout flips a task out of 'running',
 * the still-live stream must settle with the real reason (not the generic
 * "Task stream ended without a final result or error"), never resurrect the
 * task, and persist exactly one terminal record.
 */
describe('DispatchPipeline post-cancel settlement', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dp-cancel-')); mkdirSync(join(root, '.gossip')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function gatedWorker(lateEvent: boolean) {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    return {
      release: () => release(),
      worker: {
        cancelTask: jest.fn(),
        executeTask: async function* () {
          await gate;
          if (lateEvent) yield { type: 'final_result', payload: { result: 'late', inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
        },
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
      },
    };
  }
  const graph = () => existsSync(join(root, '.gossip', 'task-graph.jsonl'))
    ? readFileSync(join(root, '.gossip', 'task-graph.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    : [];

  it.each([[true], [false]])('settles with the cancel reason (late event=%s) and records once', async (late) => {
    const g = gatedWorker(late);
    const p = new DispatchPipeline({
      projectRoot: root,
      workers: new Map([['a', g.worker as any]]),
      registryGet: (id: string) => ({ id, provider: 'local' as const, model: 'mock', skills: [] }),
    });
    const { taskId, finalResultPromise } = p.dispatch('a', 'inspect');
    p.cancelRunningTasks();
    g.release();
    await expect(finalResultPromise).rejects.toThrow('Cancelled by user');
    const task = p.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('Cancelled by user');
    expect(task?.result).toBeUndefined();
    const events = graph().filter(e => e.taskId === taskId && e.type !== 'task.created');
    expect(events.map(e => e.type)).toEqual(['task.cancelled']);
    expect(events[0].reason).toBe('Cancelled by user');
    expect(events.some(e => e.type === 'task.completed' || e.type === 'task.failed')).toBe(false);
  });
});
