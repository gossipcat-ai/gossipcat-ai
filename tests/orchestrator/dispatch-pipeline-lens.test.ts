import { DispatchPipeline } from '@gossip/orchestrator';

// Minimal mock worker
function mockWorker(result = 'done') {
  return {
    executeTask: jest.fn().mockImplementation(async function* () {
      yield { type: 'final_result', payload: { result, inputTokens: 0, outputTokens: 0 }, timestamp: Date.now() };
    }),
    subscribeToBatch: jest.fn().mockResolvedValue(undefined),
    unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DispatchPipeline — lens option', () => {
  let pipeline: DispatchPipeline;
  let workers: Map<string, ReturnType<typeof mockWorker>>;

  beforeEach(() => {
    workers = new Map([['test-agent', mockWorker()]]);
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-lens-test-' + Date.now(),
      workers,
      registryGet: (id) =>
        id === 'test-agent'
          ? { id: 'test-agent', provider: 'local' as const, model: 'mock', skills: [] }
          : undefined,
    });
  });

  it('includes LENS block in prompt when lens option is provided', async () => {
    const { finalResultPromise: promise } = pipeline.dispatch('test-agent', 'review code', {
      lens: 'Focus on security vulnerabilities',
    });
    await promise;

    const worker = workers.get('test-agent')!;
    expect(worker.executeTask).toHaveBeenCalledTimes(1);
    const promptContent: string = worker.executeTask.mock.calls[0][2];
    expect(promptContent).toContain('LENS');
    expect(promptContent).toContain('Focus on security vulnerabilities');
  });

  it('does NOT include LENS block in prompt when no lens option is provided', async () => {
    const { finalResultPromise: promise } = pipeline.dispatch('test-agent', 'review code');
    await promise;

    const worker = workers.get('test-agent')!;
    const promptContent: string = worker.executeTask.mock.calls[0][2];
    expect(promptContent).not.toContain('LENS');
  });
});
