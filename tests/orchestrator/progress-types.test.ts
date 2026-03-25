import type { TaskProgressEvent, TaskEntry } from '@gossip/orchestrator';

describe('TaskProgressEvent', () => {
  it('accepts all valid status values', () => {
    const statuses: TaskProgressEvent['status'][] = [
      'init', 'start', 'progress', 'done', 'error', 'finish',
    ];
    for (const status of statuses) {
      const event: TaskProgressEvent = {
        taskIndex: 0,
        totalTasks: 3,
        agentId: 'agent-1',
        taskDescription: 'do something',
        status,
      };
      expect(event.status).toBe(status);
    }
  });

  it('init event carries agents list', () => {
    const event: TaskProgressEvent = {
      taskIndex: 0,
      totalTasks: 2,
      agentId: 'orchestrator',
      taskDescription: 'plan initialized',
      status: 'init',
      agents: [
        { agentId: 'agent-alpha', task: 'review code' },
        { agentId: 'agent-beta', task: 'run tests' },
      ],
    };
    expect(event.agents).toHaveLength(2);
    expect(event.agents![0].agentId).toBe('agent-alpha');
    expect(event.agents![1].task).toBe('run tests');
  });

  it('progress event carries telemetry fields', () => {
    const event: TaskProgressEvent = {
      taskIndex: 1,
      totalTasks: 3,
      agentId: 'agent-alpha',
      taskDescription: 'analyzing files',
      status: 'progress',
      toolCalls: 4,
      inputTokens: 1200,
      outputTokens: 300,
      currentTool: 'read_file',
      turn: 2,
    };
    expect(event.toolCalls).toBe(4);
    expect(event.inputTokens).toBe(1200);
    expect(event.outputTokens).toBe(300);
    expect(event.currentTool).toBe('read_file');
    expect(event.turn).toBe(2);
  });

  it('done event carries result', () => {
    const event: TaskProgressEvent = {
      taskIndex: 1,
      totalTasks: 3,
      agentId: 'agent-alpha',
      taskDescription: 'write component',
      status: 'done',
      result: 'Component created at src/Button.tsx',
    };
    expect(event.result).toBeDefined();
    expect(event.error).toBeUndefined();
  });

  it('error event carries error message', () => {
    const event: TaskProgressEvent = {
      taskIndex: 2,
      totalTasks: 3,
      agentId: 'agent-beta',
      taskDescription: 'run tests',
      status: 'error',
      error: 'Test suite failed',
    };
    expect(event.error).toBe('Test suite failed');
    expect(event.result).toBeUndefined();
  });
});

describe('TaskEntry.toolCalls', () => {
  it('accepts optional toolCalls field', () => {
    const entry: TaskEntry = {
      id: 'task-1',
      agentId: 'agent-alpha',
      task: 'review PR',
      status: 'completed',
      startedAt: Date.now(),
      toolCalls: 7,
    };
    expect(entry.toolCalls).toBe(7);
  });

  it('toolCalls is optional — entry without it is valid', () => {
    const entry: TaskEntry = {
      id: 'task-2',
      agentId: 'agent-beta',
      task: 'lint code',
      status: 'running',
      startedAt: Date.now(),
    };
    expect(entry.toolCalls).toBeUndefined();
  });
});
