/**
 * Consensus engine resolutionRoots + findFile hardening tests (#126 PR-B).
 */
import {
  ConsensusEngine,
  type ConsensusEngineConfig,
} from '../../packages/orchestrator/src/consensus-engine';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const makeLlm = (): any => ({
  generate: jest.fn(async () => ({ text: '[]', usage: { inputTokens: 0, outputTokens: 0 } })),
});

describe('ConsensusEngine resolutionRoots + findFile hardening', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cer-'));
    root = realpathSync(tmp);
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('Test 11 — constructor seeds currentWorktreeRoots + currentRealpathRoots', () => {
    const extra = join(root, 'wt');
    mkdirSync(extra);
    const real = realpathSync(extra);
    const engine = new ConsensusEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: root,
      resolutionRoots: [real],
    } as ConsensusEngineConfig);
    // getValidRoots is private — exercise via matchesRelativePath which
    // works off the roots the engine was seeded with.
    const m = (engine as any).matchesRelativePath(real, join(real, 'a.ts'), 'a.ts');
    expect(m).toBe(true);
  });

  it('constructor throws on relative path (validation-layer invariant)', () => {
    expect(() => new ConsensusEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: root,
      resolutionRoots: ['relative/path'],
    } as ConsensusEngineConfig)).toThrow(/absolute/);
  });

  it('Test 14 — matchesRelativePath: exact trailing match', () => {
    const engine = new ConsensusEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root,
    });
    const m = (engine as any).matchesRelativePath.bind(engine);
    // trailing match succeeds
    expect(m('/r', '/r/packages/foo/bar.ts', 'foo/bar.ts')).toBe(true);
    // exact full match
    expect(m('/r', '/r/packages/foo/bar.ts', 'packages/foo/bar.ts')).toBe(true);
    // basename-only collision is rejected when cite has directory
    expect(m('/r', '/r/packages/other/bar.ts', 'packages/foo/bar.ts')).toBe(false);
    // too many segments in ref → false
    expect(m('/r', '/r/a.ts', 'x/y/a.ts')).toBe(false);
    // escape attempt
    expect(m('/r', '/outside/a.ts', 'a.ts')).toBe(false);
  });

  it('Test 15 — findFile skips symlinked subdirs during walk', async () => {
    // /root/repo with an apps/cli/src directory; inside, a symlinked subdir
    // `packages/evil → /etc`. findFile for "config.ts" should NOT surface
    // anything from /etc.
    const repo = realpathSync(mkdtempSync(join(tmp, 'repo')));
    mkdirSync(join(repo, 'packages'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'config.ts'), 'ok');
    // Create an external target to symlink to
    const outside = realpathSync(mkdtempSync(join(tmp, 'outside')));
    writeFileSync(join(outside, 'config.ts'), 'secret');
    symlinkSync(outside, join(repo, 'packages', 'evil'));
    const engine = new ConsensusEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: repo,
    });
    // findFile is private — invoke via the resolver path.
    const resolved = await (engine as any).resolveFilePath('config.ts');
    // Must match the real file inside repo, NOT the symlink target's config.ts.
    // Because the symlink is skipped, any match comes from repo/packages/config.ts.
    expect(resolved).not.toBeNull();
    const real = realpathSync(resolved);
    expect(real).toBe(realpathSync(join(repo, 'packages', 'config.ts')));
  });

  it('Test 13 — findFile bare ref outside projectRoot: not matched', async () => {
    // Two "repos": projectRoot and an extra root with the same filename.
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    const extra = realpathSync(mkdtempSync(join(tmp, 'extra')));
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'A.ts'), 'a-main');
    mkdirSync(join(extra, 'src'), { recursive: true });
    writeFileSync(join(extra, 'src', 'A.ts'), 'a-extra');
    const engine = new ConsensusEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: proj,
      resolutionRoots: [extra],
    } as ConsensusEngineConfig);
    const resolved = await (engine as any).resolveFilePath('A.ts');
    // Bare-filename recursion restricted to projectRoot — must find the
    // proj copy, never the extra copy.
    expect(resolved).not.toBeNull();
    expect(realpathSync(resolved).startsWith(proj)).toBe(true);
  });

  it('Test 12 — cache invalidation when resolutionRoots changes between rounds', async () => {
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    writeFileSync(join(proj, 'x.ts'), 'x');
    const wt1 = realpathSync(mkdtempSync(join(tmp, 'wt1')));
    const wt2 = realpathSync(mkdtempSync(join(tmp, 'wt2')));

    const engine = new ConsensusEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: proj,
      resolutionRoots: [wt1],
    } as ConsensusEngineConfig);

    // Trigger cache population via updateWorktreeRoots
    (engine as any).updateWorktreeRoots([], [wt1]);
    // Pre-seed pathCache with a stale entry
    (engine as any).pathCache.set('x.ts', '/stale/wt1/x.ts');
    // Rebuild with different roots — should invalidate caches
    (engine as any).updateWorktreeRoots([], [wt2]);
    expect((engine as any).pathCache.size).toBe(0);
  });
});
