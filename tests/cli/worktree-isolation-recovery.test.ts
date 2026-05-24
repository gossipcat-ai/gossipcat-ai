/**
 * Tests for non-destructive worktree isolation recovery (`preserveLeakedPaths`).
 * Spec: docs/specs/2026-05-24-worktree-isolation-nondestructive-recovery.md
 *
 * Unlike worktree-isolation-detection.test.ts (which mocks execFileSync), these
 * tests drive a REAL git repo in a temp dir. The highest-risk invariant — that
 * `git add -N` → `git diff` → `git reset` leaves the working tree byte-identical
 * — can only be proven against a real index, and the round-trip claim (`git apply`
 * reproduces the leaked work) requires real patch semantics.
 *
 * Covers:
 *   - Leaked NEW (untracked) file → patch captures it; tree byte-identical after
 *     preserve; `git apply` reproduces the file.
 *   - Leaked MODIFIED (tracked) file → patch captures the diff.
 *   - Mixed new + modified → both in one patch.
 *   - taskId with path-traversal chars → rejected by SAFE_NAME; no file written
 *     outside .gossip/recovery/; error returned, no throw.
 *   - preserve failure (non-git cwd) → returns { error }, does NOT throw.
 *   - Absolute / leading-dash paths → listed in rejected[].
 *   - filterSafePaths shared filter unit behaviour.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  preserveLeakedPaths,
  filterSafePaths,
} from '../../apps/cli/src/handlers/worktree-isolation-detection';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function porcelain(cwd: string): string {
  return git(cwd, ['status', '--porcelain']);
}

describe('filterSafePaths', () => {
  it('passes repo-relative paths, rejects absolute, leading-dash, and empty', () => {
    const r = filterSafePaths(['ok.ts', 'a/b/c.ts', '/etc/passwd', '--force', '']);
    expect(r.safe).toEqual(['ok.ts', 'a/b/c.ts']);
    // f4 (PR #495): empty-string paths now surface in rejected[] (in input
    // order) instead of vanishing silently.
    expect(r.rejected).toEqual(['/etc/passwd', '--force', '']);
  });

  it('empty input → both empty', () => {
    expect(filterSafePaths([])).toEqual({ safe: [], rejected: [] });
  });
});

describe('preserveLeakedPaths — real git repo', () => {
  let repo: string;

  function initRepo(): void {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
  }

  function writeFile(rel: string, content: string): void {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function commitAll(msg: string): void {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', msg]);
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-leaked-'));
    initRepo();
    // Baseline commit so HEAD exists and `git diff` has a comparison point.
    // `.gossip/` is gitignored exactly as in the real project root, so the
    // recovery artifact dir never appears in porcelain — the byte-identical
    // invariant is asserted against the leaked paths only, not the artifact.
    writeFile('.gitignore', '.gossip/\n');
    writeFile('README.md', 'baseline\n');
    commitAll('init');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('empty paths → no-op, no patch, no error, emptyDiff sentinel set', () => {
    const r = preserveLeakedPaths(repo, [], 'task-abc');
    expect(r).toEqual({ preserved: [], skipped: [], rejected: [], emptyDiff: true });
    expect(fs.existsSync(path.join(repo, '.gossip', 'recovery'))).toBe(false);
  });

  it('empty diff (present path, no content delta) → no patch, emptyDiff sentinel set, no error', () => {
    // README.md is tracked and unmodified since the baseline commit: it exists
    // on disk (passes the present-file check) so git runs, but `git diff`
    // yields nothing. f1: no zero-byte patch is written and patchPath stays
    // unset. The `emptyDiff` sentinel lets the call site distinguish this
    // "nothing to do" state from a genuine preserve failure
    // (consensus 9abe6f5a-6db14a27 f2) so it does not emit the recovery alarm.
    const before = porcelain(repo);
    const r = preserveLeakedPaths(repo, ['README.md'], 'task-emptydiff');
    const after = porcelain(repo);

    expect(after).toBe(before);
    expect(r.error).toBeUndefined();
    expect(r.patchPath).toBeUndefined();
    expect(r.preserved).toEqual([]);
    expect(r.emptyDiff).toBe(true);
    expect(fs.existsSync(path.join(repo, '.gossip', 'recovery', 'task-emptydiff.patch'))).toBe(false);
  });

  it('benign no-patch early returns all set emptyDiff (empty input, all-rejected, all-vanished)', () => {
    // 72981222-c54b4c11 f5: every benign "nothing to preserve" early return must
    // set emptyDiff so the caller skips the destructive revert calmly instead of
    // raising the false "could NOT preserve leaked work" alarm.
    // (a) empty input
    expect(preserveLeakedPaths(repo, [], 'task-none').emptyDiff).toBe(true);
    // (b) all paths rejected by the safety filter → present.length === 0
    const rej = preserveLeakedPaths(repo, ['/etc/passwd', '--force'], 'task-rej');
    expect(rej.emptyDiff).toBe(true);
    expect(rej.rejected).toEqual(['/etc/passwd', '--force']);
    expect(rej.patchPath).toBeUndefined();
    // (c) safe paths that no longer exist on disk → all skipped, present.length === 0
    const gone = preserveLeakedPaths(repo, ['apps/cli/vanished.ts', 'also-gone.ts'], 'task-gone');
    expect(gone.emptyDiff).toBe(true);
    expect(gone.skipped.sort()).toEqual(['also-gone.ts', 'apps/cli/vanished.ts']);
    expect(gone.preserved).toEqual([]);
    expect(gone.patchPath).toBeUndefined();
    expect(fs.existsSync(path.join(repo, '.gossip', 'recovery'))).toBe(false);
  });

  it('taskId validation failure sets error, NOT emptyDiff (genuine failure keeps the alarm)', () => {
    // The taskId-validation early return is a real error and must remain
    // distinguishable from the benign emptyDiff no-ops.
    const r = preserveLeakedPaths(repo, ['apps/cli/src/leaked.ts'], '../escape');
    expect(r.error).toMatch(/SAFE_NAME/);
    expect(r.emptyDiff).toBeUndefined();
  });

  it('leaked NEW untracked file → patch captures it; tree byte-identical; git apply reproduces', () => {
    writeFile('apps/cli/src/leaked.ts', 'export const leaked = 42;\n');

    const before = porcelain(repo);
    const r = preserveLeakedPaths(repo, ['apps/cli/src/leaked.ts'], 'task-new');
    const after = porcelain(repo);

    // HIGHEST-RISK INVARIANT: working tree byte-identical before/after preserve.
    expect(after).toBe(before);

    expect(r.error).toBeUndefined();
    expect(r.preserved).toEqual(['apps/cli/src/leaked.ts']);
    expect(r.patchPath).toBe(path.join(repo, '.gossip', 'recovery', 'task-new.patch'));
    expect(fs.existsSync(r.patchPath!)).toBe(true);

    const patch = fs.readFileSync(r.patchPath!, 'utf8');
    expect(patch).toMatch(/apps\/cli\/src\/leaked\.ts/);
    expect(patch).toMatch(/export const leaked = 42;/);

    // Round-trip: delete the file, then `git apply` must reproduce it exactly.
    fs.rmSync(path.join(repo, 'apps/cli/src/leaked.ts'));
    git(repo, ['apply', r.patchPath!]);
    expect(fs.readFileSync(path.join(repo, 'apps/cli/src/leaked.ts'), 'utf8')).toBe(
      'export const leaked = 42;\n',
    );
  });

  it('leaked MODIFIED tracked file → patch captures the diff', () => {
    // README.md is tracked from the baseline commit; modify it.
    writeFile('README.md', 'baseline\nleaked modification\n');

    const before = porcelain(repo);
    const r = preserveLeakedPaths(repo, ['README.md'], 'task-mod');
    const after = porcelain(repo);

    expect(after).toBe(before);
    expect(r.error).toBeUndefined();
    expect(r.preserved).toEqual(['README.md']);

    const patch = fs.readFileSync(r.patchPath!, 'utf8');
    expect(patch).toMatch(/README\.md/);
    expect(patch).toMatch(/\+leaked modification/);
  });

  it('mixed new + modified → both in one patch', () => {
    writeFile('README.md', 'baseline\nchanged\n');           // modified tracked
    writeFile('apps/new-file.ts', 'const x = 1;\n');          // new untracked

    const before = porcelain(repo);
    const r = preserveLeakedPaths(repo, ['README.md', 'apps/new-file.ts'], 'task-mixed');
    const after = porcelain(repo);

    expect(after).toBe(before);
    expect(r.error).toBeUndefined();
    expect(r.preserved.sort()).toEqual(['README.md', 'apps/new-file.ts'].sort());

    const patch = fs.readFileSync(r.patchPath!, 'utf8');
    expect(patch).toMatch(/README\.md/);
    expect(patch).toMatch(/apps\/new-file\.ts/);
    expect(patch).toMatch(/\+changed/);
    expect(patch).toMatch(/const x = 1;/);
  });

  it('taskId with path-traversal chars → rejected by SAFE_NAME; no file outside recovery dir; no throw', () => {
    writeFile('apps/leaked.ts', 'x\n');
    let r: ReturnType<typeof preserveLeakedPaths> | undefined;
    expect(() => { r = preserveLeakedPaths(repo, ['apps/leaked.ts'], '../etc/x'); }).not.toThrow();

    expect(r!.error).toMatch(/SAFE_NAME/);
    expect(r!.patchPath).toBeUndefined();
    expect(r!.preserved).toEqual([]);

    // Nothing written outside .gossip/recovery/ (no escape via ../).
    expect(fs.existsSync(path.join(repo, '.gossip', 'recovery'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(repo), 'etc'))).toBe(false);
  });

  it('preserve failure (non-git cwd) → returns { error }, does NOT throw', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-nongit-'));
    fs.writeFileSync(path.join(nonGit, 'leaked.ts'), 'x\n');
    try {
      let r: ReturnType<typeof preserveLeakedPaths> | undefined;
      expect(() => { r = preserveLeakedPaths(nonGit, ['leaked.ts'], 'task-nongit'); }).not.toThrow();
      expect(r!.error).toBeDefined();
      expect(r!.patchPath).toBeUndefined();
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('absolute / leading-dash paths → listed in rejected[]; safe paths still preserved', () => {
    writeFile('ok.ts', 'const ok = 1;\n');
    const r = preserveLeakedPaths(repo, ['ok.ts', '/etc/passwd', '--force'], 'task-reject');
    expect(r.rejected).toEqual(['/etc/passwd', '--force']);
    expect(r.preserved).toEqual(['ok.ts']);
    expect(r.error).toBeUndefined();
    expect(fs.readFileSync(r.patchPath!, 'utf8')).toMatch(/ok\.ts/);
  });

  it('all rejected (no safe present paths) → no patch, no git invocation', () => {
    const r = preserveLeakedPaths(repo, ['/etc/passwd', '--force'], 'task-allreject');
    expect(r.rejected).toEqual(['/etc/passwd', '--force']);
    expect(r.preserved).toEqual([]);
    expect(r.patchPath).toBeUndefined();
    expect(r.error).toBeUndefined();
  });
});
