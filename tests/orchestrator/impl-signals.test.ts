import { ImplSignal } from '@gossip/orchestrator';

describe('ImplSignal type contracts', () => {
  test('impl_test_pass signal is well-formed', () => {
    const signal: ImplSignal = {
      type: 'impl',
      signal: 'impl_test_pass',
      agentId: 'agent-a',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
    };
    expect(signal.type).toBe('impl');
    expect(signal.signal).toBe('impl_test_pass');
  });

  test('impl_test_fail signal includes evidence', () => {
    const signal: ImplSignal = {
      type: 'impl',
      signal: 'impl_test_fail',
      agentId: 'agent-a',
      taskId: 'task-1',
      evidence: 'Tests failed: 3 failures',
      timestamp: new Date().toISOString(),
    };
    expect(signal.evidence).toBe('Tests failed: 3 failures');
  });

  test('impl_peer_approved signal is well-formed', () => {
    const signal: ImplSignal = {
      type: 'impl',
      signal: 'impl_peer_approved',
      agentId: 'agent-a',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
    };
    expect(signal.signal).toBe('impl_peer_approved');
  });

  test('impl_peer_rejected signal is well-formed', () => {
    const signal: ImplSignal = {
      type: 'impl',
      signal: 'impl_peer_rejected',
      agentId: 'agent-a',
      taskId: 'task-1',
      evidence: 'Code has security issues',
      timestamp: new Date().toISOString(),
    };
    expect(signal.signal).toBe('impl_peer_rejected');
  });
});
