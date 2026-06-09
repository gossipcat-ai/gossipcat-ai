/**
 * REAL-WORLD end-to-end validation of the #437 false-positive fix.
 * Spec: docs/specs/2026-06-09-worktree-isolation-false-positive-attribution.md
 *
 * Unlike worktree-isolation-false-positive.test.ts — which drives
 * `diffIsolationSnapshots` with synthetic snapshots and mocks git for Layer B —
 * these tests stand up a REAL git repo in a temp dir and reproduce each of
 * @GravyaDev's three reported incidents end-to-end through the REAL exported
 * functions (`captureIsolationSnapshot`, `checkIsolationViolation`,
 * `preserveLeakedPaths`, `revertLeakedPaths`) against real `git status` /
 * `git restore`. The assertions are on the ACTUAL on-disk file contents — the
 * thing that was being destroyed in production.
 *
 * Incident map (issue #437):
 *   S1  6-07  (task 13996c4c) orchestrator appended to .claude/knowledge-nominations.md
 *             during an in-flight worktree dispatch → detector attributed it to
 *             the agent and git-restore'd it. MUST now be excluded → no violation
 *             → the orchestrator's journal line survives on disk.
 *   S2  Regression proof: the PRE-FIX attribution (after.dirty − before.dirty,
 *             no exclusion) DID flag that path, and `revertLeakedPaths` on it
 *             really does wipe the orchestrator's line. Proves the bug was real
 *             and that S1's no-violation is what prevents reaching the revert.
 *   S3  6-06 i1 default-OFF: a real source-file leak → violation, but the relay
 *             default branch preserves WITHOUT reverting → leaked work stays on
 *             disk + a recovery patch exists. No data loss by default.
 *   S4  flag=1 opt-in: same leak, relay opt-in branch preserves THEN reverts →
 *             master is cleaned (pre-#437 behaviour) and the work is recoverable
 *             via the patch.
 *   S5  operator glob: a write under an operator `orchestratorOwnedGlobs` entry
 *             is excluded just like the built-ins → no violation → survives.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  captureIsolationSnapshot,
  checkIsolationViolation,
  preserveLeakedPaths,
  revertLeakedPaths,
} from '../../apps/cli/src/handlers/worktree-isolation-detection';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

describe('worktree-isolation #437 — real git repo, end-to-end incident reproduction', () => {
  let repo: string;

  function writeFile(rel: string, content: string): void {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function read(rel: string): string {
    return fs.readFileSync(path.join(repo, rel), 'utf8');
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rw437-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    // `.gossip/` is gitignored exactly as in the real project root so recovery
    // artifacts never appear in porcelain.
    writeFile('.gitignore', '.gossip/\n');
    // Baseline tracked files: the orchestrator journal (S1/S2) and a source
    // file that an agent will later leak into (S3/S4). Both committed so
    // `git restore --source=HEAD` has a clean version to revert to.
    writeFile('.claude/knowledge-nominations.md', '# nominations\n');
    writeFile('packages/x/leaked.ts', 'export const ok = 1;\n');
    // A journal dir the operator excludes via orchestratorOwnedGlobs (S5).
    // Tracked at baseline because `git status --porcelain` COLLAPSES a wholly-
    // untracked directory to `docs/` (one entry) — a deep glob would miss that.
    // Real journaling dirs are already in the repo, so a new file in them shows
    // its full path. (Built-in .gossip//.claude/ prefixes are immune: a
    // collapsed `?? .claude/` still startsWith('.claude/').)
    writeFile('docs/journal/.gitkeep', '');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'baseline']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  // ── S1: the exact 6-07 incident is now a non-event ────────────────────────
  it('S1 (6-07): orchestrator journaling to .claude/ during dispatch → no violation, line survives', () => {
    const before = captureIsolationSnapshot(repo); // dispatch-time snapshot

    // Orchestrator appends a journal line WHILE the agent task is "in flight".
    const journalLine = 'nominated: real-world-check\n';
    fs.appendFileSync(path.join(repo, '.claude/knowledge-nominations.md'), journalLine);

    const diff = checkIsolationViolation('opus-implementer', '13996c4c', before, repo, false, []);

    expect(diff.isViolation).toBe(false);
    expect(diff.dirtyPathsAdded).toEqual([]); // nothing attributed to the agent
    expect(diff.excludedPaths).toContain('.claude/knowledge-nominations.md');
    // The decisive real-world assertion: the orchestrator's line is STILL on disk.
    expect(read('.claude/knowledge-nominations.md')).toContain(journalLine.trim());
  });

  // ── S2: regression proof — pre-fix attribution really did destroy it ───────
  it('S2 (regression proof): the OLD attribution flags the .claude/ write and revert WIPES it', () => {
    const before = captureIsolationSnapshot(repo);
    const journalLine = 'nominated: would-have-been-lost\n';
    fs.appendFileSync(path.join(repo, '.claude/knowledge-nominations.md'), journalLine);
    const after = captureIsolationSnapshot(repo);

    // Reconstruct the pre-#437 attribution: every added dirty path is a "leak",
    // with no orchestrator-owned exclusion (the exact bug).
    const beforeSet = new Set(before.dirty);
    const oldDirtyPathsAdded = after.dirty.filter(p => !beforeSet.has(p));
    expect(oldDirtyPathsAdded).toContain('.claude/knowledge-nominations.md'); // OLD isViolation=true

    // And the old destructive default really does wipe the orchestrator's work.
    revertLeakedPaths(repo, oldDirtyPathsAdded);
    expect(read('.claude/knowledge-nominations.md')).not.toContain(journalLine.trim());

    // Contrast: the fixed detector never reaches that revert for this input.
    const fixed = checkIsolationViolation('opus-implementer', '13996c4c', before, repo, false, []);
    expect(fixed.isViolation).toBe(false);
  });

  // ── S3: real source leak, default-OFF → preserved, NOT reverted ────────────
  it('S3 (6-06 i1, default-OFF): real source leak → violation, relay default preserves without revert', () => {
    const before = captureIsolationSnapshot(repo);

    // Agent leaks: appends to a real tracked source file in the parent checkout.
    const leak = 'export const leaked = 2;\n';
    fs.appendFileSync(path.join(repo, 'packages/x/leaked.ts'), leak);

    const diff = checkIsolationViolation('opus-implementer', 'task-s3', before, repo, false, []);
    expect(diff.isViolation).toBe(true);
    expect(diff.dirtyPathsAdded).toContain('packages/x/leaked.ts'); // genuinely attributable

    // Reproduce the relay's DEFAULT (flag OFF) branch: preserve, do NOT revert.
    const preserve = preserveLeakedPaths(repo, diff.dirtyPathsAdded, 'task-s3');
    expect(preserve.patchPath).toBeTruthy();
    expect(fs.existsSync(path.join(repo, '.gossip/recovery/task-s3.patch'))).toBe(true);
    // No revertLeakedPaths call on the default path → the leaked work stays put.
    expect(read('packages/x/leaked.ts')).toContain(leak.trim());
  });

  // ── S4: opt-in flag → preserve THEN revert (pre-#437 behaviour, recoverable)
  it('S4 (flag=1 opt-in): same leak → relay opt-in preserves then reverts; work recoverable via patch', () => {
    const before = captureIsolationSnapshot(repo);
    const leak = 'export const leaked = 3;\n';
    fs.appendFileSync(path.join(repo, 'packages/x/leaked.ts'), leak);

    const diff = checkIsolationViolation('opus-implementer', 'task-s4', before, repo, false, []);
    expect(diff.isViolation).toBe(true);

    // Reproduce the relay's OPT-IN branch: preserve THEN revert.
    const preserve = preserveLeakedPaths(repo, diff.dirtyPathsAdded, 'task-s4');
    expect(preserve.patchPath).toBeTruthy();
    revertLeakedPaths(repo, diff.dirtyPathsAdded);

    // Master is cleaned …
    expect(read('packages/x/leaked.ts')).not.toContain(leak.trim());
    // … but the work is recoverable: applying the patch restores it.
    git(repo, ['apply', path.join(repo, '.gossip/recovery/task-s4.patch')]);
    expect(read('packages/x/leaked.ts')).toContain(leak.trim());
  });

  // ── S5: operator-configured glob is excluded just like the built-ins ───────
  it('S5 (operator glob): a write under orchestratorOwnedGlobs is excluded → no violation, survives', () => {
    const before = captureIsolationSnapshot(repo);

    const note = '# session journal\n';
    writeFile('docs/journal/today.md', note); // new untracked file during dispatch

    const diff = checkIsolationViolation('opus-implementer', 'task-s5', before, repo, false, [
      'docs/journal/**',
    ]);

    expect(diff.isViolation).toBe(false);
    expect(diff.excludedPaths).toContain('docs/journal/today.md');
    expect(fs.existsSync(path.join(repo, 'docs/journal/today.md'))).toBe(true);
    expect(read('docs/journal/today.md')).toBe(note);
  });
});
