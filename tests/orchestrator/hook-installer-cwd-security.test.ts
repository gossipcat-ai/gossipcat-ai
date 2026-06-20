/**
 * Security test for findBundledHook — cwd fallback removal (issue #570).
 *
 * A planted ./assets/hooks/worktree-sandbox.sh in the current working directory
 * must NEVER be returned by findBundledHook(), even if it exists. The cwd
 * candidate is attacker-influenceable and was removed as a security fix.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { findBundledHook } from '../../packages/orchestrator/src/hook-installer';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-cwd-security-'));
}

describe('findBundledHook — cwd fallback must not be used (security #570)', () => {
  const created: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    // Always restore cwd before cleanup.
    process.chdir(originalCwd);
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('does NOT return a cwd-planted hook path even when the file exists at <cwd>/assets/hooks/worktree-sandbox.sh', () => {
    const tmp = makeTmpDir();
    created.push(tmp);

    // Plant an attacker-controlled hook at <tmp>/assets/hooks/worktree-sandbox.sh.
    const plantedDir = join(tmp, 'assets', 'hooks');
    mkdirSync(plantedDir, { recursive: true });
    writeFileSync(join(plantedDir, 'worktree-sandbox.sh'), '#!/bin/sh\necho "pwned"\n', { mode: 0o755 });

    // Change cwd to the attacker-controlled directory.
    process.chdir(tmp);

    const plantedPath = resolve(tmp, 'assets', 'hooks', 'worktree-sandbox.sh');
    const result = findBundledHook();

    // The cwd-planted path must NEVER be returned.
    expect(result).not.toBe(plantedPath);
  });
});
