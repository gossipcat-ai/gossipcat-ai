/**
 * Absolute-path citation resolution (issue #660).
 *
 * `join(root, '/abs/root/src/f.ts')` produces '/abs/root/abs/root/src/f.ts',
 * so before the fix every absolute citation failed anchor resolution even when
 * the file existed inside a configured root. These tests pin the fix AND the
 * sandbox guarantee it must not weaken.
 */
import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';
import { testRound } from '../../packages/orchestrator/src/round-context';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const makeLlm = (): any => ({
  generate: jest.fn(async () => ({ text: '[]', usage: { inputTokens: 0, outputTokens: 0 } })),
});

const makeEngine = (projectRoot: string, resolutionRoots: string[] = []): any =>
  new ConsensusEngine({
    llm: makeLlm(),
    registryGet: () => undefined,
    projectRoot,
    round: testRound({ resolutionRoots }),
  });

const writeFileAt = (path: string, contents = 'export const x = 1;\n'): string => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
};

describe('ConsensusEngine — absolute citation paths (#660)', () => {
  let tmp: string;
  let root: string;
  let repo: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cea-'));
    root = realpathSync(tmp);
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('resolves an absolute path that lies inside projectRoot', async () => {
    const target = writeFileAt(join(repo, 'packages', 'orchestrator', 'src', 'thing.ts'));
    const engine = makeEngine(repo);

    const resolved = await engine.resolveFilePath(target);

    expect(resolved).toBe(target);
  });

  it('resolves an absolute path inside a worktree resolutionRoot', async () => {
    const wt = join(repo, '.claude', 'worktrees', 'wt-1');
    mkdirSync(wt, { recursive: true });
    const target = writeFileAt(join(wt, 'packages', 'a', 'only-here.ts'));
    const engine = makeEngine(repo, [wt]);

    const resolved = await engine.resolveFilePath(target);

    expect(resolved).toBe(target);
  });

  it('does NOT resolve an absolute path outside every configured root (sandbox preserved)', async () => {
    const outside = writeFileAt(join(root, 'outside', 'src', 'zz-secret-only.ts'));
    const engine = makeEngine(repo);

    const resolved = await engine.resolveFilePath(outside);

    expect(resolved).toBeNull();
  });

  it('does NOT resolve a sibling-prefix path (no naive startsWith containment)', async () => {
    // `<root>/repo-evil` shares a textual prefix with root `<root>/repo`.
    const evil = writeFileAt(join(root, 'repo-evil', 'src', 'zz-evil-only.ts'));
    const engine = makeEngine(repo);

    const resolved = await engine.resolveFilePath(evil);

    expect(resolved).toBeNull();
  });

  it('repairs a worktree-root mismatch by stripping the root prefix and re-joining', async () => {
    // File exists ONLY in the worktree; the agent cited it under projectRoot.
    const wt = join(repo, '.claude', 'worktrees', 'wt-1');
    mkdirSync(wt, { recursive: true });
    const target = writeFileAt(join(wt, 'packages', 'a', 'branch-only.ts'));
    const citedAs = join(repo, 'packages', 'a', 'branch-only.ts');
    const engine = makeEngine(repo, [wt]);

    const resolved = await engine.resolveFilePath(citedAs);

    expect(resolved).toBe(target);
  });

  it('prefers the worktree copy for anchor resolution when both roots have the file', async () => {
    const wt = join(repo, '.claude', 'worktrees', 'wt-1');
    mkdirSync(wt, { recursive: true });
    writeFileAt(join(repo, 'packages', 'a', 'both.ts'), 'master\n');
    const wtCopy = writeFileAt(join(wt, 'packages', 'a', 'both.ts'), 'branch\n');
    const engine = makeEngine(repo, [wt]);

    // Cited with the worktree-mismatched (projectRoot) prefix. priorityRoots is
    // authoritative: strip-and-rejoin runs before as-is acceptance, so the
    // WORKTREE copy wins — an absolute cite must not pin the reviewer to master
    // HEAD just because the file also exists there.
    const cited = await engine.cachedResolveForAnchor(join(repo, 'packages', 'a', 'both.ts'));
    expect(cited).toBe(wtCopy);

    // A bare-relative citation honours the same ordering.
    const anchored = await engine.cachedResolveForAnchor('packages/a/both.ts');
    expect(anchored).toBe(wtCopy);

    // Non-anchor resolution (projectRoot-first priority) still returns master.
    expect(await engine.resolveFilePath(join(repo, 'packages', 'a', 'both.ts')))
      .toBe(join(repo, 'packages', 'a', 'both.ts'));
  });

  // Fix (3): the prefix comparison must be realpath-symmetric. With resolve()
  // only, a root configured through a symlink never matches as a prefix, so
  // strip-and-rejoin silently degrades to nothing. Note this suite's other
  // tests sidestep the bug by realpath'ing tmp in setup — this one builds the
  // asymmetry explicitly (root via symlink, citation via realpath).
  it('strips a symlinked root prefix when re-joining (realpath-symmetric)', async () => {
    const realRepo = join(root, 'realrepo');
    const linkRepo = join(root, 'linkrepo');
    mkdirSync(realRepo, { recursive: true });
    symlinkSync(realRepo, linkRepo);
    const wt = join(linkRepo, '.claude', 'worktrees', 'wt-1');
    mkdirSync(wt, { recursive: true });
    const target = writeFileAt(join(wt, 'packages', 'a', 'branch-only.ts'));
    const engine = makeEngine(linkRepo, [wt]);

    // Roots are configured through the symlink; the agent cited the realpath.
    const citedAs = join(realRepo, 'packages', 'a', 'branch-only.ts');

    expect(await engine.resolveFilePath(citedAs)).toBe(realpathSync(target));
  });

  // Fix (2): stat() succeeds for directories, so a directory citation used to
  // "resolve"; cachedRead then hit EISDIR and the anchor was dropped silently
  // instead of being counted as an unresolvable citation.
  it('does NOT resolve a citation that points at a directory', async () => {
    mkdirSync(join(repo, 'packages', 'orchestrator'), { recursive: true });
    const engine = makeEngine(repo);

    // Absolute form (acceptCandidate gate).
    expect(await engine.resolveFilePath(join(repo, 'packages', 'orchestrator'))).toBeNull();
    // Relative form (relative-loop gate).
    expect(await engine.resolveFilePath('packages/orchestrator')).toBeNull();
  });

  it('leaves relative citation resolution unchanged', async () => {
    const target = writeFileAt(join(repo, 'packages', 'orchestrator', 'src', 'rel-thing.ts'));
    const engine = makeEngine(repo);

    expect(await engine.resolveFilePath('packages/orchestrator/src/rel-thing.ts')).toBe(target);
    // Trailing-segment match still works.
    expect(await engine.resolveFilePath('src/rel-thing.ts')).toBe(target);
    // Basename collision against a different directory is still rejected.
    expect(await engine.resolveFilePath('packages/other/rel-thing.ts')).toBeNull();
    // Non-existent relative path still resolves to null.
    expect(await engine.resolveFilePath('packages/orchestrator/src/zz-nope.ts')).toBeNull();
  });

  it('returns null for an absolute path inside a root that does not exist on disk', async () => {
    const engine = makeEngine(repo);

    const resolved = await engine.resolveFilePath(join(repo, 'packages', 'a', 'zz-ghost-only.ts'));

    expect(resolved).toBeNull();
  });

  // Regression: the first cut of this fix passed the RAW fileRef to
  // acceptCandidate, which let `<root>/<symlinked-dir>/../secret.ts` escape
  // every configured root. isInsideAnyRoot collapses `..` textually (so the
  // path looks contained), but stat/readFile let the kernel resolve `..` AFTER
  // following the symlink — landing outside. realpathSync pre-resolves
  // textually, so it ENOENT'd and the old fail-OPEN catch kept the raw path,
  // making the post-realpath containment check a no-op. Caught by
  // fable-reviewer; out-of-root file contents reached the <anchor> block.
  //
  // NOTE: the attack path MUST be built by string concat — join()/resolve()
  // collapse `..` textually and silently defuse the exploit.
  it('does NOT resolve an absolute path that escapes via a symlinked dir plus ..', async () => {
    const victimDir = join(root, 'victim');
    mkdirSync(join(victimDir, 'nested'), { recursive: true });
    writeFileSync(join(victimDir, 'creds.ts'), 'const SECRET = "sk-EXFILTRATED";\n');
    symlinkSync(join(victimDir, 'nested'), join(repo, 'link'));
    const engine = makeEngine(repo);

    const escape = repo + '/link/../creds.ts';

    expect(await engine.resolveFilePath(escape)).toBeNull();
    expect(await engine.cachedResolveForAnchor(escape)).toBeNull();
  });

  it('does NOT resolve an absolute path through a symlinked dir that leaves the root', async () => {
    const victimDir = join(root, 'victim2');
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(join(victimDir, 'leak.ts'), 'const SECRET = "leaked";\n');
    symlinkSync(victimDir, join(repo, 'out'));
    const engine = makeEngine(repo);

    expect(await engine.resolveFilePath(join(repo, 'out', 'leak.ts'))).toBeNull();
  });
});
