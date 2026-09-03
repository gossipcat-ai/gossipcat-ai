/**
 * Tests for issue #736 — a relay/native task that actually completed before
 * an MCP reconnect/restart gets restored as `timed_out`
 * (restoreRelayTasksAsFailed / restoreNativeTaskMap), and collect.ts's
 * auto-signal step (Step 3.5) then reports a phantom `task_timeout` even
 * though a real `task_completed` signal is already on the ledger for the
 * same taskId.
 *
 * `findPhantomTimeoutIds` is the pure guard collect.ts consults before
 * deciding whether a `timed_out` result should actually emit `task_timeout`.
 */
import { findPhantomTimeoutIds } from '../../apps/cli/src/handlers/collect';

function jsonl(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('findPhantomTimeoutIds — #736 phantom task_timeout guard', () => {
  it('returns empty when there are no timed-out candidates, even with a matching ledger row', () => {
    const raw = jsonl([{ signal: 'task_completed', taskId: 'abc123', agentId: 'agent-1' }]);
    expect(findPhantomTimeoutIds(new Set(), raw)).toEqual(new Set());
  });

  it('returns empty when the ledger has no rows at all (real timeout, nothing on disk)', () => {
    expect(findPhantomTimeoutIds(new Set(['abc123']), '')).toEqual(new Set());
    expect(findPhantomTimeoutIds(new Set(['abc123']), undefined)).toEqual(new Set());
    expect(findPhantomTimeoutIds(new Set(['abc123']), null)).toEqual(new Set());
  });

  it('flags a taskId as phantom when a task_completed row already exists for it', () => {
    const raw = jsonl([
      { signal: 'task_completed', taskId: 'abc123', agentId: 'agent-1' },
      { signal: 'task_completed', taskId: 'other-task', agentId: 'agent-2' },
    ]);
    const result = findPhantomTimeoutIds(new Set(['abc123']), raw);
    expect(result).toEqual(new Set(['abc123']));
  });

  it('does not flag a taskId with no matching task_completed row (a real timeout)', () => {
    const raw = jsonl([{ signal: 'task_completed', taskId: 'unrelated-task', agentId: 'agent-1' }]);
    expect(findPhantomTimeoutIds(new Set(['abc123']), raw)).toEqual(new Set());
  });

  it('ignores other signal types for the same taskId — only task_completed counts', () => {
    const raw = jsonl([
      { signal: 'disagreement', taskId: 'abc123', agentId: 'agent-1' },
      { signal: 'hallucination_caught', taskId: 'abc123', agentId: 'agent-1' },
    ]);
    expect(findPhantomTimeoutIds(new Set(['abc123']), raw)).toEqual(new Set());
  });

  it('handles multiple timed-out candidates, flagging only the ones with a real completion', () => {
    const raw = jsonl([
      { signal: 'task_completed', taskId: 'task-a', agentId: 'agent-1' },
    ]);
    const result = findPhantomTimeoutIds(new Set(['task-a', 'task-b']), raw);
    expect(result).toEqual(new Set(['task-a']));
  });

  it('tolerates a torn/unparseable line without throwing and still finds the valid rows', () => {
    const raw = '{"signal": "task_completed", "taskId": "abc123", "agentId": "agent-1"}\n{not valid json\n';
    expect(() => findPhantomTimeoutIds(new Set(['abc123']), raw)).not.toThrow();
    expect(findPhantomTimeoutIds(new Set(['abc123']), raw)).toEqual(new Set(['abc123']));
  });

  it('ignores blank lines between rows', () => {
    const raw = '\n{"signal": "task_completed", "taskId": "abc123", "agentId": "agent-1"}\n\n';
    expect(findPhantomTimeoutIds(new Set(['abc123']), raw)).toEqual(new Set(['abc123']));
  });
});
