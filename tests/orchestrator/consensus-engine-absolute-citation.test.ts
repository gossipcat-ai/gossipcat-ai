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
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
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

    // Cited with the worktree-mismatched (projectRoot) prefix — the file exists
    // at both locations, so step 1 (as-is) wins and returns the cited copy.
    const cited = await engine.resolveFilePath(join(repo, 'packages', 'a', 'both.ts'));
    expect(cited).toBe(join(repo, 'packages', 'a', 'both.ts'));

    // A bare-relative citation still honours worktree-priority ordering.
    const anchored = await engine.cachedResolveForAnchor('packages/a/both.ts');
    expect(anchored).toBe(wtCopy);
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
});
