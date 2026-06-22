import { MetaSignal } from '@gossip/orchestrator';

describe('MetaSignal types', () => {
  test('task_completed MetaSignal is well-formed', () => {
    const signal: MetaSignal = {
      type: 'meta',
      signal: 'task_completed',
      agentId: 'test-agent',
      taskId: 'task-123',
      value: 5000,
      timestamp: new Date().toISOString(),
    };
    expect(signal.type).toBe('meta');
    expect(signal.signal).toBe('task_completed');
    expect(signal.value).toBe(5000);
  });

  test('task_tool_turns MetaSignal is well-formed', () => {
    const signal: MetaSignal = {
      type: 'meta',
      signal: 'task_tool_turns',
      agentId: 'test-agent',
      taskId: 'task-123',
      value: 8,
      timestamp: new Date().toISOString(),
    };
    expect(signal.value).toBe(8);
  });
});
