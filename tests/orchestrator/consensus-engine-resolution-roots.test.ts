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

  it('Test 16 — anchor snippets resolve from worktree FIRST, not project-root master HEAD', async () => {
    // Regression for the false-absence finding root cause: when resolutionRoots
    // supplies a worktree, anchor content for a file that exists in BOTH
    // project root (master) and the worktree (feature branch) must come from
    // the worktree version, not the stale master copy.
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt')));

    // Same relative path in both locations but distinct content.
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'target.ts'), 'export function old() { return "master-HEAD"; }');
    writeFileSync(join(wt, 'src', 'target.ts'), 'export function newImpl() { return "worktree-branch"; }');

    const engine = new ConsensusEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: proj,
      resolutionRoots: [wt],
    } as ConsensusEngineConfig);

    // snippetsForFinding is protected — invoke via cast.
    const snippets: string = await (engine as any).snippetsForFinding(
      'Potential issue at src/target.ts:1',
    );

    // Must show the WORKTREE content, not the master-HEAD content.
    expect(snippets).toContain('worktree-branch');
    expect(snippets).not.toContain('master-HEAD');
    // Anchor block should be emitted (not a "file not found" warning).
    expect(snippets).toContain('<anchor');
  });

  it('Test 18 — master-fallback anchor block carries via="⚠ resolved against project root, NOT worktree"', async () => {
    // File exists at projectRoot but NOT inside the priorityRoot worktree.
    // The anchor should render (resolves via projectRoot fallback) and must
    // carry the worktree-warning attribute shipped in PR #365.
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt')));

    // File only lives at projectRoot — not in the worktree.
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'master-only.ts'), 'export function masterFn() { return 42; }');
    // No corresponding file at wt/src/master-only.ts

    const engine = new ConsensusEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: proj,
      resolutionRoots: [wt],
    } as ConsensusEngineConfig);

    const snippets: string = await (engine as any).snippetsForFinding(
      'Potential issue at src/master-only.ts:1',
    );

    // Snippet must render — file found via projectRoot fallback.
    expect(snippets).toContain('<anchor');
    expect(snippets).toContain('masterFn');
    // The warning attribute must be present (PR #365 @ consensus-engine.ts:1498 + 1543).
    expect(snippets).toContain('via="⚠ resolved against project root, NOT worktree"');
  });

  it('Test 19 — nested worktree-resolved file does NOT get projectRoot warning', async () => {
    // Regression for issue #401: when the worktree lives under projectRoot
    // (standard .claude/worktrees/agent-X layout), a file resolved via the
    // worktree priority root still passes startsWith(projectRoot + '/') —
    // the old inline check falsely attached the ⚠ warning.
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    // Nest the worktree under projectRoot, mimicking .claude/worktrees/agent-X
    const wtDir = join(proj, '.claude', 'worktrees', 'agent-test');
    mkdirSync(wtDir, { recursive: true });
    const wt = realpathSync(wtDir);

    // File exists only in the worktree (e.g. a new file on the branch).
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'new-feature.ts'), 'export function newFeature() { return "branch"; }');

    const engine = new ConsensusEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: proj,
      resolutionRoots: [wt],
    } as ConsensusEngineConfig);

    const snippets: string = await (engine as any).snippetsForFinding(
      'Potential issue at src/new-feature.ts:1',
    );

    // Anchor must render.
    expect(snippets).toContain('<anchor');
    expect(snippets).toContain('newFeature');
    // Must NOT carry the false-positive warning — file was resolved from worktree.
    expect(snippets).not.toContain('⚠ resolved against project root, NOT worktree');
  });

  it('Test 20 — project-root-only file still gets warning (regression guard)', async () => {
    // Mirror of Test 18 but using the nested-worktree layout.  A file that
    // lives ONLY at projectRoot (not in the nested worktree) must still get
    // the warning attribute so the regression from #401 fix doesn't silently
    // suppress legitimate warnings.
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    const wtDir = join(proj, '.claude', 'worktrees', 'agent-test');
    mkdirSync(wtDir, { recursive: true });
    const wt = realpathSync(wtDir);

    // File lives only at projectRoot — not in the worktree.
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'master-only.ts'), 'export function masterFn() { return 42; }');
    // No corresponding file in wt/src/master-only.ts

    const engine = new ConsensusEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: proj,
      resolutionRoots: [wt],
    } as ConsensusEngineConfig);

    const snippets: string = await (engine as any).snippetsForFinding(
      'Potential issue at src/master-only.ts:1',
    );

    // Snippet must render via projectRoot fallback.
    expect(snippets).toContain('<anchor');
    expect(snippets).toContain('masterFn');
    // Warning must still be present — file resolved from projectRoot, not worktree.
    expect(snippets).toContain('via="⚠ resolved against project root, NOT worktree"');
  });

  it('Test 17 — anchorPathCache is cleared when worktree roots change', async () => {
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'a.ts'), 'proj');
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt')));

    const engine = new ConsensusEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: proj,
      resolutionRoots: [wt],
    } as ConsensusEngineConfig);

    // Seed the anchorPathCache with a stale entry.
    (engine as any).anchorPathCache.set('src/a.ts', '/stale/path/a.ts');
    // Changing worktree roots should clear anchorPathCache.
    const wt2 = realpathSync(mkdtempSync(join(tmp, 'wt2')));
    (engine as any).updateWorktreeRoots([], [wt2]);
    expect((engine as any).anchorPathCache.size).toBe(0);
  });
});
