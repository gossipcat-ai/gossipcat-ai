/**
 * Tests for validate-resolution-root (issue #126 PR-B).
 *
 * Pipeline: NUL → `..` → exists → realpath → ownership → git-common-dir →
 * worktree-list. NUL is fatal (REJECT ROUND); others drop the path.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateResolutionRoot,
  parseWorktreePorcelain,
  hashPath,
} from '../../packages/orchestrator/src/validate-resolution-root';
import { discoverGitWorktrees } from '../../packages/orchestrator/src/discover-git-worktrees';

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

describe('validateResolutionRoot', () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vrr-')));
    repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    repo = realpathSync(repo);
    initRepo(repo);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Test 3 (NUL byte) — fatal, round-level reject', async () => {
    const r = await validateResolutionRoot('bad\x00path', repo);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.fatal).toBe(true);
      expect(r.reason).toMatch(/NUL|control/i);
    }
  });

  it('Test 3b (ESC control char) — fatal', async () => {
    const r = await validateResolutionRoot('bad\x1bpath', repo);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.fatal).toBe(true);
  });

  it('Test 4 (parent traversal) — drop, non-fatal', async () => {
    const r = await validateResolutionRoot('../something', repo);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.fatal).toBeFalsy();
      expect(r.reason).toMatch(/\.\./);
    }
  });

  it('Test 5 (outside git-common-dir — different repo) — drop', async () => {
    const other = join(tmp, 'other');
    mkdirSync(other);
    initRepo(other);
    const r = await validateResolutionRoot(other, repo);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/git-common-dir|not found/i);
  });

  it('Test 8 (cross-repo) — drop', async () => {
    const other = join(tmp, 'cross');
    mkdirSync(other);
    initRepo(other);
    const r = await validateResolutionRoot(other, repo);
    expect(r.valid).toBe(false);
  });

  it('Test 1 happy path (added worktree) — valid + canonical', async () => {
    const wt = join(tmp, 'wt-feature');
    // Create another branch from scratch to add a worktree
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-q', wt, 'feature'], { cwd: repo });
    const r = await validateResolutionRoot(wt, repo);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.canonical).toBe(realpathSync(wt));
    }
  });

  it('Test 10 (non-existent path) — drop', async () => {
    const r = await validateResolutionRoot(join(tmp, 'nope'), repo);
    expect(r.valid).toBe(false);
  });

  it('hashPath produces sha256:<8 hex>', () => {
    const h = hashPath('anything');
    expect(h).toMatch(/^sha256:[0-9a-f]{8}$/);
  });
});

describe('parseWorktreePorcelain', () => {
  it('skips bare / locked / prunable; parses worktree paths', () => {
    // Simulated porcelain: three records separated by \0\0.
    const rec1 = ['worktree /a', 'HEAD deadbeef', 'branch refs/heads/main'].join('\0');
    const rec2 = ['worktree /b', 'HEAD deadbeef', 'locked some reason'].join('\0');
    const rec3 = ['worktree /c', 'HEAD deadbeef', 'bare'].join('\0');
    const stdout = [rec1, rec2, rec3].join('\0\0');
    const paths = parseWorktreePorcelain(stdout);
    // /a is the only non-locked non-bare; /b /c skipped. realpath best-effort
    // returns input when the path does not exist.
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths.some((p) => p.endsWith('/a') || p === '/a')).toBe(true);
    expect(paths.some((p) => p.endsWith('/b'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/c'))).toBe(false);
  });

  it('Test 7 (locked with reason) — skipped', () => {
    const rec = ['worktree /x', 'locked for maintenance'].join('\0');
    expect(parseWorktreePorcelain(rec)).toHaveLength(0);
  });

  it('handles trailing \\0\\0 gracefully', () => {
    const rec = ['worktree /z', 'HEAD abc'].join('\0') + '\0\0';
    const paths = parseWorktreePorcelain(rec);
    expect(paths.some((p) => p.endsWith('/z'))).toBe(true);
  });

  it('caps output at 100 entries', () => {
    const rec = (i: number) => ['worktree /p' + i, 'HEAD xx'].join('\0');
    const stdout = Array.from({ length: 250 }, (_, i) => rec(i)).join('\0\0');
    expect(parseWorktreePorcelain(stdout).length).toBeLessThanOrEqual(100);
  });
});

describe('discoverGitWorktrees', () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dgw-')));
    repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    repo = realpathSync(repo);
    initRepo(repo);
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('Test 2 + Test 22 (hardened git env; discovers added worktrees that pass validation)', async () => {
    const wt = join(tmp, 'wt');
    execFileSync('git', ['checkout', '-qb', 'feat'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-q', wt, 'feat'], { cwd: repo });
    const { discovered, rejected } = await discoverGitWorktrees(repo);
    // Should find at least the added worktree. The main repo itself is
    // listed by `git worktree list` but exclude logic is caller-side;
    // discoverGitWorktrees returns every passing path including main.
    expect(discovered.length).toBeGreaterThanOrEqual(1);
    expect(discovered.some((p) => p === realpathSync(wt))).toBe(true);
    expect(rejected).toBeDefined();
  });

  it('excludes paths in the caller-supplied exclude set', async () => {
    const wt = join(tmp, 'wt2');
    execFileSync('git', ['checkout', '-qb', 'ff'], { cwd: repo });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-q', wt, 'ff'], { cwd: repo });
    const realWt = realpathSync(wt);
    const { discovered } = await discoverGitWorktrees(repo, [realWt]);
    expect(discovered.includes(realWt)).toBe(false);
  });
});
