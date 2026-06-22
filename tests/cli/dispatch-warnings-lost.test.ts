/**
 * f11 follow-up (consensus dfe05be2-73794442:f11): the in-memory
 * pendingDispatchWarnings stash is reconnect-volatile, but the native task
 * entry carries a persisted `dispatchWarningsStashed` marker. At collect time,
 * a task whose marker is set but whose stash entry is gone (reconnect wiped it)
 * must surface a `dispatch_warnings_lost` RoundWarning so the LOSS is fail-loud.
 *
 * Extended (consensus 1f50d89d-c28f49c4:fable-reviewer:f1): the marker must
 * also be checked on the RESULT MAP for tasks that completed (were relayed)
 * before the /mcp reconnect — such tasks are absent from nativeTaskMap but
 * their result record carries dispatchWarningsStashed (copied at relay time).
 */
import { detectLostDispatchWarnings } from '../../apps/cli/src/handlers/dispatch';

describe('detectLostDispatchWarnings — fail-loud on reconnect-wiped stash (f11)', () => {
  it('emits one warning per task whose marker is set but stash entry is gone', () => {
    const taskMap = new Map<string, { dispatchWarningsStashed?: boolean }>([
      ['task-a', { dispatchWarningsStashed: true }],
      ['task-b', { dispatchWarningsStashed: true }],
    ]);
    // Simulate /mcp reconnect: the stash was wiped (empty), markers survived.
    const stash = new Map<string, unknown>();

    const warnings = detectLostDispatchWarnings(['task-a', 'task-b'], taskMap, stash);
    expect(warnings).toHaveLength(2);
    expect(warnings.every(w => w.code === 'dispatch_warnings_lost')).toBe(true);
    expect(warnings[0].message).toContain('task-a');
    expect(warnings[1].message).toContain('task-b');
  });

  it('emits NO warning when the stash still holds the task (no reconnect)', () => {
    const taskMap = new Map<string, { dispatchWarningsStashed?: boolean }>([
      ['task-a', { dispatchWarningsStashed: true }],
    ]);
    const stash = new Map<string, unknown>([['task-a', [{ code: 'roots_rejected', message: 'x' }]]]);

    expect(detectLostDispatchWarnings(['task-a'], taskMap, stash)).toEqual([]);
  });

  it('emits NO warning for tasks without the marker (no warnings ever stashed)', () => {
    const taskMap = new Map<string, { dispatchWarningsStashed?: boolean }>([
      ['task-a', {}],
      ['task-b', { dispatchWarningsStashed: false }],
    ]);
    const stash = new Map<string, unknown>();

    expect(detectLostDispatchWarnings(['task-a', 'task-b'], taskMap, stash)).toEqual([]);
  });

  it('emits NO warning for relay-only task ids absent from the native task map', () => {
    const taskMap = new Map<string, { dispatchWarningsStashed?: boolean }>();
    const stash = new Map<string, unknown>();

    expect(detectLostDispatchWarnings(['relay-1', 'relay-2'], taskMap, stash)).toEqual([]);
  });
});

describe('detectLostDispatchWarnings — completed-task lifecycle (result-map path)', () => {
  it('emits warning when marker is on result record (task completed before reconnect, task map entry already deleted)', () => {
    // Simulate: task dispatched with warnings stashed, relay called (task deleted
    // from nativeTaskMap, result added to nativeResultMap with marker copied),
    // then /mcp reconnect wiped the in-memory stash.
    const taskMap = new Map<string, { dispatchWarningsStashed?: boolean }>();
    const resultMap = new Map<string, { dispatchWarningsStashed?: boolean }>([
      ['task-a', { dispatchWarningsStashed: true }],
    ]);
    const stash = new Map<string, unknown>(); // wiped by reconnect

    const warnings = detectLostDispatchWarnings(['task-a'], taskMap, stash, resultMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('dispatch_warnings_lost');
    expect(warnings[0].message).toContain('task-a');
    // Message is cause-neutral (does not hard-attribute to reconnect only).
    expect(warnings[0].message).not.toContain('likely /mcp reconnect');
    expect(warnings[0].message).toContain('reconnect or stash eviction');
  });

  it('emits NO warning when result map marker is set but stash is still live (task completed before collect, no reconnect)', () => {
    const taskMap = new Map<string, { dispatchWarningsStashed?: boolean }>();
    const resultMap = new Map<string, { dispatchWarningsStashed?: boolean }>([
      ['task-a', { dispatchWarningsStashed: true }],
    ]);
    const stash = new Map<string, unknown>([
      ['task-a', [{ code: 'roots_rejected', message: 'x' }]],
    ]);

    expect(detectLostDispatchWarnings(['task-a'], taskMap, stash, resultMap)).toEqual([]);
  });

  it('emits NO warning when result record has no marker (no warnings were ever stashed)', () => {
    const taskMap = new Map<string, { dispatchWarningsStashed?: boolean }>();
    const resultMap = new Map<string, { dispatchWarningsStashed?: boolean }>([
      ['task-a', {}],
    ]);
    const stash = new Map<string, unknown>();

    expect(detectLostDispatchWarnings(['task-a'], taskMap, stash, resultMap)).toEqual([]);
  });

  it('handles stash cap-eviction cause: task map marker present, stash gone due to eviction (not reconnect)', () => {
    // Both reconnect and cap-eviction produce the same observable state:
    // marker set, stash entry absent. The warning message is cause-neutral.
    const taskMap = new Map<string, { dispatchWarningsStashed?: boolean }>([
      ['old-task', { dispatchWarningsStashed: true }],
    ]);
    const stash = new Map<string, unknown>(); // evicted due to cap

    const warnings = detectLostDispatchWarnings(['old-task'], taskMap, stash);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('reconnect or stash eviction');
  });
});
