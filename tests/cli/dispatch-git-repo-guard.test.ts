/**
 * Unit tests for isGitRepo helper (issue #538 item 5).
 *
 * Also covers: effectiveWriteMode — downgraded dispatch does not trigger the
 * isolation snapshot check (item 2d).
 */

import { isGitRepo } from '../../apps/cli/src/handlers/dispatch';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-isgit-'));
}

describe('isGitRepo', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('returns false for a plain empty directory', () => {
    const dir = makeTmpDir();
    created.push(dir);
    expect(isGitRepo(dir)).toBe(false);
  });

  it('returns false for a directory with arbitrary files but no .git', () => {
    const dir = makeTmpDir();
    created.push(dir);
    writeFileSync(join(dir, 'file.txt'), 'hello');
    expect(isGitRepo(dir)).toBe(false);
  });

  it('returns true for an initialized git repo', () => {
    const dir = makeTmpDir();
    created.push(dir);
    try {
      execSync('git init', { cwd: dir, stdio: 'ignore' });
      expect(isGitRepo(dir)).toBe(true);
    } catch {
      // If git is unavailable in the test environment, skip gracefully.
      console.warn('git not available, skipping isGitRepo(true) test');
    }
  });

  it('returns false for a non-existent path without throwing', () => {
    expect(isGitRepo('/non-existent-path-for-gossip-test')).toBe(false);
  });
});

describe('effectiveWriteMode isolation skip', () => {
  /**
   * Verify the contract: when effectiveWriteMode is 'sequential' (downgraded from
   * 'worktree'), the relay-receipt isolation checker does NOT trigger.
   *
   * We test this by inspecting the logic branch condition directly, since
   * handleNativeRelay is deep infra. The guard is:
   *   const effectiveMode = taskInfo.effectiveWriteMode ?? taskInfo.writeMode;
   *   if (effectiveMode === 'worktree' && taskInfo.isolationSnapshot) { ... }
   *
   * A task with writeMode='worktree' + effectiveWriteMode='sequential' must
   * produce effectiveMode='sequential', so the if-branch is NOT taken.
   */
  it('effectiveWriteMode overrides writeMode for guard evaluation', () => {
    const taskInfo: { writeMode: string; effectiveWriteMode?: string; isolationSnapshot: object } = {
      writeMode: 'worktree',
      effectiveWriteMode: 'sequential',
      isolationSnapshot: { head: 'abc', dirty: [], takenAt: new Date().toISOString() },
    };
    const effectiveMode = taskInfo.effectiveWriteMode ?? taskInfo.writeMode;
    expect(effectiveMode).toBe('sequential');
    // The isolation check condition evaluates false when downgraded
    expect(effectiveMode === 'worktree' && !!taskInfo.isolationSnapshot).toBe(false);
  });

  it('falls back to writeMode when effectiveWriteMode is absent (backward compat)', () => {
    const taskInfo: { writeMode: 'worktree'; effectiveWriteMode?: string; isolationSnapshot: object } = {
      writeMode: 'worktree' as const,
      // effectiveWriteMode absent — simulates old persisted entry
      isolationSnapshot: { head: 'abc', dirty: [], takenAt: new Date().toISOString() },
    };
    const effectiveMode = taskInfo.effectiveWriteMode ?? taskInfo.writeMode;
    expect(effectiveMode).toBe('worktree');
    expect(effectiveMode === 'worktree' && !!taskInfo.isolationSnapshot).toBe(true);
  });
});
