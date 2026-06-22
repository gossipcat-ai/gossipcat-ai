// tests/cli/progress-tree-integration.test.ts
import { ProgressTree } from '../../apps/cli/src/progress-tree';

describe('ProgressTree integration', () => {
  const mockRl = { pause: jest.fn(), resume: jest.fn() };
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((_chunk: any) => { return true; });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    mockRl.pause.mockClear();
    mockRl.resume.mockClear();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('simulates a full parallel plan lifecycle', () => {
    const tree = new ProgressTree(mockRl as any);

    // init
    tree.start([
      { agentId: 'impl', task: 'build login form' },
      { agentId: 'reviewer', task: 'review auth code' },
    ]);
    expect(tree.isActive()).toBe(true);

    // both start running
    tree.update('impl', {
      taskIndex: 0, totalTasks: 2, agentId: 'impl',
      taskDescription: 'build login form', status: 'start',
    });
    tree.update('reviewer', {
      taskIndex: 1, totalTasks: 2, agentId: 'reviewer',
      taskDescription: 'review auth code', status: 'start',
    });

    // impl progresses through several tool calls
    tree.update('impl', {
      taskIndex: 0, totalTasks: 2, agentId: 'impl',
      taskDescription: 'build login form', status: 'progress',
      toolCalls: 1, currentTool: 'read_file', inputTokens: 1000, outputTokens: 500,
    });
    tree.update('impl', {
      taskIndex: 0, totalTasks: 2, agentId: 'impl',
      taskDescription: 'build login form', status: 'progress',
      toolCalls: 3, currentTool: 'write_file', inputTokens: 5000, outputTokens: 2000,
    });

    // reviewer finishes first
    tree.update('reviewer', {
      taskIndex: 1, totalTasks: 2, agentId: 'reviewer',
      taskDescription: 'review auth code', status: 'done',
      toolCalls: 2, inputTokens: 3000, outputTokens: 1000,
    });

    // impl finishes
    tree.update('impl', {
      taskIndex: 0, totalTasks: 2, agentId: 'impl',
      taskDescription: 'build login form', status: 'done',
      toolCalls: 8, inputTokens: 8000, outputTokens: 4200,
    });

    // finish
    tree.finish();
    expect(tree.isActive()).toBe(false);
    expect(mockRl.resume).toHaveBeenCalled();

    // Verify output contained expected elements
    const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('');
    expect(allOutput).toContain('impl');
    expect(allOutput).toContain('reviewer');
    expect(allOutput).toContain('✓');
    expect(allOutput).toContain('done');
  });

  it('simulates a sequential plan with pending → running transitions', () => {
    const tree = new ProgressTree(mockRl as any);

    tree.start([
      { agentId: 'agent-1', task: 'first task' },
      { agentId: 'agent-2', task: 'second task' },
    ]);

    // First agent starts and completes
    tree.update('agent-1', {
      taskIndex: 0, totalTasks: 2, agentId: 'agent-1',
      taskDescription: 'first task', status: 'start',
    });
    tree.update('agent-1', {
      taskIndex: 0, totalTasks: 2, agentId: 'agent-1',
      taskDescription: 'first task', status: 'done',
      toolCalls: 3, inputTokens: 2000, outputTokens: 800,
    });

    // Second agent starts and completes
    tree.update('agent-2', {
      taskIndex: 1, totalTasks: 2, agentId: 'agent-2',
      taskDescription: 'second task', status: 'start',
    });
    tree.update('agent-2', {
      taskIndex: 1, totalTasks: 2, agentId: 'agent-2',
      taskDescription: 'second task', status: 'done',
      toolCalls: 5, inputTokens: 4000, outputTokens: 1500,
    });

    tree.finish();
    expect(tree.isActive()).toBe(false);
  });

  it('handles Ctrl+C mid-execution gracefully', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);

    tree.update('impl', {
      taskIndex: 0, totalTasks: 1, agentId: 'impl',
      taskDescription: 'build', status: 'progress',
      toolCalls: 2, currentTool: 'read_file',
    });

    // Simulate Ctrl+C — finish while still running
    tree.finish();
    expect(tree.isActive()).toBe(false);
    expect(mockRl.resume).toHaveBeenCalled();
  });

  it('handles error status', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);

    tree.update('impl', {
      taskIndex: 0, totalTasks: 1, agentId: 'impl',
      taskDescription: 'build', status: 'start',
    });
    tree.update('impl', {
      taskIndex: 0, totalTasks: 1, agentId: 'impl',
      taskDescription: 'build', status: 'error',
      error: 'timeout after 120s',
    });

    tree.finish();
    expect(tree.isActive()).toBe(false);

    const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('');
    expect(allOutput).toContain('✗');
  });

  it('handles unknown agentId in update gracefully', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);

    // Update with an agentId that doesn't exist — should not throw
    expect(() => tree.update('nonexistent', {
      taskIndex: 0, totalTasks: 1, agentId: 'nonexistent',
      taskDescription: 'build', status: 'progress',
      toolCalls: 1, currentTool: 'read_file',
    })).not.toThrow();

    tree.finish();
  });

  it('handles double finish gracefully', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'impl', task: 'build' }]);
    tree.finish();
    expect(() => tree.finish()).not.toThrow();
    expect(tree.isActive()).toBe(false);
  });
});
