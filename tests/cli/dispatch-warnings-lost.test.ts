/**
 * f11 follow-up (consensus dfe05be2-73794442:f11): the in-memory
 * pendingDispatchWarnings stash is reconnect-volatile, but the native task
 * entry carries a persisted `dispatchWarningsStashed` marker. At collect time,
 * a task whose marker is set but whose stash entry is gone (reconnect wiped it)
 * must surface a `dispatch_warnings_lost` RoundWarning so the LOSS is fail-loud.
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
