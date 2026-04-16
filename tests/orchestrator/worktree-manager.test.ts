import { WorktreeManager } from '../../packages/orchestrator/src/worktree-manager';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('WorktreeManager', () => {
  const testDir = join(tmpdir(), `gossip-wt-test-${Date.now()}`);
  let manager: WorktreeManager;

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: testDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir });
  });

  afterAll(() => { rmSync(testDir, { recursive: true, force: true }); });

  beforeEach(() => { manager = new WorktreeManager(testDir); });

  it('creates a worktree with a branch', async () => {
    const { path, branch } = await manager.create('test-1');
    expect(existsSync(path)).toBe(true);
    expect(branch).toBe('gossip-test-1');
    await manager.cleanup('test-1', path);
  });

  it('merges a worktree with changes', async () => {
    const { path } = await manager.create('test-2');
    writeFileSync(join(path, 'new-file.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['commit', '-m', 'add file'], { cwd: path });

    const result = await manager.merge('test-2');
    expect(result.merged).toBe(true);
    expect(existsSync(join(testDir, 'new-file.txt'))).toBe(true);
    await manager.cleanup('test-2', path);
  });

  it('cleanup force-deletes unmerged branches', async () => {
    const { path } = await manager.create('test-4');
    // Make a commit on the worktree branch (unmerged)
    writeFileSync(join(path, 'unmerged.txt'), 'data');
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['commit', '-m', 'unmerged change'], { cwd: path });

    await manager.cleanup('test-4', path);

    // Verify branch is actually deleted
    const branches = execFileSync('git', ['branch', '--list', 'gossip-test-4'], { cwd: testDir }).toString().trim();
    expect(branches).toBe('');
  });

  it('runs pre-merge-commit hook on non-ff merge', async () => {
    const hookDir = join(testDir, '.git', 'hooks');
    const sentinel = join(tmpdir(), `gossip-hook-sentinel-${Date.now()}`);
    const hookPath = join(hookDir, 'pre-merge-commit');
    writeFileSync(hookPath, `#!/bin/sh\ntouch ${sentinel}\nexit 0\n`);
    chmodSync(hookPath, 0o755);

    const { path } = await manager.create('test-hook');
    writeFileSync(join(path, 'wt-only.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['commit', '-m', 'wt'], { cwd: path });

    // Force non-ff by adding a commit on main after worktree branched
    writeFileSync(join(testDir, 'main-only.txt'), 'y');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'main'], { cwd: testDir });

    await manager.merge('test-hook');
    expect(existsSync(sentinel)).toBe(true);

    rmSync(hookPath, { force: true });
    rmSync(sentinel, { force: true });
    await manager.cleanup('test-hook', path);
  });

  it('detects merge conflicts', async () => {
    const { path } = await manager.create('test-3');

    writeFileSync(join(testDir, 'conflict.txt'), 'main version');
    execFileSync('git', ['add', '.'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'main change'], { cwd: testDir });

    writeFileSync(join(path, 'conflict.txt'), 'worktree version');
    execFileSync('git', ['add', '.'], { cwd: path });
    execFileSync('git', ['commit', '-m', 'wt change'], { cwd: path });

    const result = await manager.merge('test-3');
    expect(result.merged).toBe(false);
    expect(result.conflicts).toBeDefined();
    await manager.cleanup('test-3', path);
  });
});
