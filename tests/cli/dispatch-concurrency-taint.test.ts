/**
 * Unit tests for stampConcurrencyTaint — the lifetime-taint helper that stamps
 * concurrent worktree-mode task entries at dispatch time.
 *
 * Closes the CRITICAL last-finisher false-attribution race in
 * checkIsolationViolation (consensus 3e89a9c2-ec574f6b f1). See
 * docs/specs/2026-05-20-native-worktree-isolation-fix.md §"Lifetime taint".
 */

import { stampConcurrencyTaint } from '../../apps/cli/src/handlers/dispatch';

interface TaskEntry {
  writeMode?: string;
  concurrentWorktreeTaint?: boolean;
}

describe('stampConcurrencyTaint', () => {
  it('returns false for empty map', () => {
    const map = new Map<string, TaskEntry>();
    expect(stampConcurrencyTaint(map)).toBe(false);
  });

  it('returns true and mutates existing worktree entry when one worktree task is present', () => {
    const existing: TaskEntry = { writeMode: 'worktree', concurrentWorktreeTaint: undefined };
    const map = new Map<string, TaskEntry>([['task-1', existing]]);

    const result = stampConcurrencyTaint(map);

    expect(result).toBe(true);
    expect(existing.concurrentWorktreeTaint).toBe(true);
  });

  it('returns false and leaves sequential entry untouched when no worktree tasks present', () => {
    const existing: TaskEntry = { writeMode: 'sequential', concurrentWorktreeTaint: undefined };
    const map = new Map<string, TaskEntry>([['task-1', existing]]);

    const result = stampConcurrencyTaint(map);

    expect(result).toBe(false);
    expect(existing.concurrentWorktreeTaint).toBeUndefined();
  });

  it('only taints worktree entries in a mixed map (worktree + sequential + scoped)', () => {
    const worktreeEntry: TaskEntry = { writeMode: 'worktree' };
    const sequentialEntry: TaskEntry = { writeMode: 'sequential' };
    const scopedEntry: TaskEntry = { writeMode: 'scoped' };
    const map = new Map<string, TaskEntry>([
      ['wt-1', worktreeEntry],
      ['seq-1', sequentialEntry],
      ['scoped-1', scopedEntry],
    ]);

    const result = stampConcurrencyTaint(map);

    expect(result).toBe(true);
    expect(worktreeEntry.concurrentWorktreeTaint).toBe(true);
    expect(sequentialEntry.concurrentWorktreeTaint).toBeUndefined();
    expect(scopedEntry.concurrentWorktreeTaint).toBeUndefined();
  });

  it('taints all N existing worktree entries when N=2', () => {
    const entry1: TaskEntry = { writeMode: 'worktree' };
    const entry2: TaskEntry = { writeMode: 'worktree' };
    const map = new Map<string, TaskEntry>([
      ['wt-1', entry1],
      ['wt-2', entry2],
    ]);

    const result = stampConcurrencyTaint(map);

    expect(result).toBe(true);
    expect(entry1.concurrentWorktreeTaint).toBe(true);
    expect(entry2.concurrentWorktreeTaint).toBe(true);
  });

  it('is idempotent — calling twice produces the same result', () => {
    const existing: TaskEntry = { writeMode: 'worktree' };
    const map = new Map<string, TaskEntry>([['wt-1', existing]]);

    const first = stampConcurrencyTaint(map);
    const second = stampConcurrencyTaint(map);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(existing.concurrentWorktreeTaint).toBe(true);
  });

  it('returns false for entry without writeMode set', () => {
    const noMode: TaskEntry = {};
    const map = new Map<string, TaskEntry>([['task-1', noMode]]);

    const result = stampConcurrencyTaint(map);

    expect(result).toBe(false);
    expect(noMode.concurrentWorktreeTaint).toBeUndefined();
  });
});
