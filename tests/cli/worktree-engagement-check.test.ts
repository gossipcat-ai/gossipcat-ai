/**
 * Unit tests for checkWorktreeEngaged — the post-relay detector that verifies
 * whether a write_mode:"worktree" dispatch actually engaged a worktree.
 *
 * Issue #538 item 1.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkWorktreeEngaged } from '../../apps/cli/src/handlers/native-tasks';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-wt-engage-'));
}

describe('checkWorktreeEngaged', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('returns false when .claude/worktrees directory does not exist', () => {
    const root = makeTmpDir();
    created.push(root);
    // No .claude/worktrees created
    expect(checkWorktreeEngaged(Date.now(), root)).toBe(false);
  });

  it('returns false when .claude/worktrees dir exists but has no agent- entries', () => {
    const root = makeTmpDir();
    created.push(root);
    mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
    // Only a non-agent entry
    mkdirSync(join(root, '.claude', 'worktrees', 'other-dir'), { recursive: true });
    expect(checkWorktreeEngaged(Date.now(), root)).toBe(false);
  });

  it('returns false when all agent- entries have mtime before startedAt', () => {
    const root = makeTmpDir();
    created.push(root);
    const wtDir = join(root, '.claude', 'worktrees', 'agent-old123');
    mkdirSync(wtDir, { recursive: true });
    // Back-date mtime to 10 seconds ago
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    utimesSync(wtDir, tenSecondsAgo, tenSecondsAgo);
    // startedAt is "now" — so the old entry is stale
    expect(checkWorktreeEngaged(Date.now(), root)).toBe(false);
  });

  it('returns true when an agent- entry has mtime >= startedAt', () => {
    const root = makeTmpDir();
    created.push(root);
    const startedAt = Date.now() - 1000; // 1 second ago
    const wtDir = join(root, '.claude', 'worktrees', 'agent-fresh456');
    mkdirSync(wtDir, { recursive: true });
    // mtime is "now" (fresh) — stat after mkdir is always >= startedAt
    expect(checkWorktreeEngaged(startedAt, root)).toBe(true);
  });

  it('returns true when one entry is fresh even if another is stale', () => {
    const root = makeTmpDir();
    created.push(root);
    const startedAt = Date.now() - 2000;

    // Stale entry
    const staleDir = join(root, '.claude', 'worktrees', 'agent-stale');
    mkdirSync(staleDir, { recursive: true });
    const veryOld = new Date(startedAt - 10_000);
    utimesSync(staleDir, veryOld, veryOld);

    // Fresh entry
    mkdirSync(join(root, '.claude', 'worktrees', 'agent-fresh'), { recursive: true });

    expect(checkWorktreeEngaged(startedAt, root)).toBe(true);
  });

  it('ignores non-directory agent- entries', () => {
    const root = makeTmpDir();
    created.push(root);
    mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
    // Create a file (not a directory) named agent-xyz
    writeFileSync(join(root, '.claude', 'worktrees', 'agent-file'), 'not a dir');
    const startedAt = Date.now() - 1000;
    // A fresh-mtime FILE must not count as an engaged worktree.
    expect(checkWorktreeEngaged(startedAt, root)).toBe(false);
  });

  it('returns false when .claude/worktrees exists but is empty', () => {
    const root = makeTmpDir();
    created.push(root);
    mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
    expect(checkWorktreeEngaged(Date.now(), root)).toBe(false);
  });

  it('tolerates up to 2s of filesystem mtime granularity (backdate window)', () => {
    const root = makeTmpDir();
    created.push(root);
    const wtDir = join(root, '.claude', 'worktrees', 'agent-coarse');
    mkdirSync(wtDir, { recursive: true });
    // Entry mtime 1.5s BEFORE startedAt — within the 2s tolerance, so it
    // still counts as engaged (mirrors the stampTaskSentinel backdate).
    const startedAt = Date.now();
    const justBefore = new Date(startedAt - 1500);
    utimesSync(wtDir, justBefore, justBefore);
    expect(checkWorktreeEngaged(startedAt, root)).toBe(true);
  });

  it('stays stale beyond the 2s tolerance window', () => {
    const root = makeTmpDir();
    created.push(root);
    const wtDir = join(root, '.claude', 'worktrees', 'agent-too-old');
    mkdirSync(wtDir, { recursive: true });
    const startedAt = Date.now();
    const beyond = new Date(startedAt - 3500);
    utimesSync(wtDir, beyond, beyond);
    expect(checkWorktreeEngaged(startedAt, root)).toBe(false);
  });
});
