/**
 * Issue #737 — an unresolvable citation must tell the cross-reviewer WHICH
 * roots were searched.
 *
 * Reported scenario: one relay process serves several repos, so `projectRoot`
 * (always `process.cwd()`) points at a directory that does not contain the
 * cited file. The resolver knew the tried-roots list but sent it only to
 * `console.warn`; the reviewer-facing annotation said a bare
 * "but file not found", which is byte-identical to the message a genuinely
 * fabricated citation produces. The reviewer has no way to tell the two apart
 * and defaults to UNVERIFIED.
 *
 * These tests pin (1) the tried-roots list reaching the prompt annotation and
 * (2) the once-per-round root log that makes the resolver's own notion of the
 * project root visible without per-citation forensics.
 */
import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';
import { testRound } from '../../packages/orchestrator/src/round-context';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

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

describe('anchor miss diagnostics (#737)', () => {
  let tmp: string;
  let root: string;
  /** The repo the resolver is (wrongly) anchored at — does NOT hold the file. */
  let wrongRepo: string;
  /** The repo the citation actually refers to. */
  let realRepo: string;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'amd-'));
    root = realpathSync(tmp);
    wrongRepo = join(root, 'other-project');
    realRepo = join(root, 'real-project');
    mkdirSync(wrongRepo, { recursive: true });
    mkdirSync(join(realRepo, 'src'), { recursive: true });
    writeFileSync(join(realRepo, 'src', 'billing.ts'), 'export const rate = 1;\n');
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('names the searched roots in the reviewer-facing annotation when the cwd is the wrong repo', async () => {
    // Resolver anchored at a repo that does not contain the cited file — the
    // citation itself is perfectly correct for `real-project`.
    const engine = makeEngine(wrongRepo);

    const out = await engine.snippetsForFinding('Rate is miscomputed at src/billing.ts:1');

    expect(out).toContain('but file not found');
    // The distinguishing information: what the resolver actually searched —
    // rendered as a basename, never the full absolute path (issue #748: the
    // full path would disclose the operator's filesystem layout to
    // relay-type reviewers backed by a third-party LLM provider).
    expect(out).toContain(basename(wrongRepo));
    expect(out).not.toContain(wrongRepo);
    expect(out).toContain('resolver searched 1 root(s)');
    // And a hint that separates "wrong root" from "wrong citation".
    expect(out).toMatch(/anchored to the wrong project/);
    // The correct repo was never searched — that is the whole point.
    expect(out).not.toContain(realRepo);
  });

  it('lists every priority root, worktree-first, so a reviewer sees the full search set', async () => {
    const worktree = join(root, 'wt-feature');
    mkdirSync(worktree, { recursive: true });
    const engine = makeEngine(wrongRepo, [worktree]);

    const out = await engine.snippetsForFinding('See src/billing.ts:1');

    expect(out).toContain('resolver searched 2 root(s)');
    // Worktree roots are checked before projectRoot (getAnchorPriorityRoots).
    // Basenames only — full absolute paths never reach the prompt.
    expect(out.indexOf(basename(worktree))).toBeLessThan(out.indexOf(basename(wrongRepo)));
    expect(out).not.toContain(worktree);
    expect(out).not.toContain(wrongRepo);
  });

  it('caps the rendered root list so a many-root round cannot bloat the prompt', async () => {
    const worktrees = ['a', 'b', 'c', 'd', 'e'].map((n) => {
      const p = join(root, `wt-${n}`);
      mkdirSync(p, { recursive: true });
      return p;
    });
    const engine = makeEngine(wrongRepo, worktrees);

    const out = await engine.snippetsForFinding('See src/billing.ts:1');

    expect(out).toContain('resolver searched 6 root(s)');
    expect(out).toContain('(+3 more)');
  });

  it('still resolves normally when the root IS correct (no diagnostic noise)', async () => {
    const engine = makeEngine(realRepo);

    const out = await engine.snippetsForFinding('Rate is miscomputed at src/billing.ts:1');

    expect(out).toContain('<anchor src="src/billing.ts:1"');
    expect(out).not.toContain('but file not found');
  });

  it('emits the resolver root list exactly once per round, not once per citation', async () => {
    const engine = makeEngine(wrongRepo);

    await engine.snippetsForFinding('alpha.ts:1 and beta.ts:2 and gamma.ts:3');
    await engine.snippetsForFinding('delta.ts:4');

    const rootLogs = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('anchor resolution roots for this round'));

    expect(rootLogs).toHaveLength(1);
    expect(rootLogs[0]).toContain(`projectRoot=${wrongRepo}`);
    expect(rootLogs[0]).toContain(wrongRepo);
  });

  it('re-arms the root log when the round changes its root set', async () => {
    const engine = makeEngine(wrongRepo);
    await engine.snippetsForFinding('alpha.ts:1');

    const worktree = join(root, 'wt-late');
    mkdirSync(worktree, { recursive: true });
    // updateWorktreeRoots is the single place the root set can change.
    engine.updateWorktreeRoots([], [worktree]);
    await engine.snippetsForFinding('alpha.ts:1');

    const rootLogs = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('anchor resolution roots for this round'));

    expect(rootLogs).toHaveLength(2);
    expect(rootLogs[1]).toContain(worktree);
  });

  it('sanitizes root paths before splicing them into the prompt annotation', async () => {
    // A root whose name carries markup must not be able to forge an <anchor>
    // boundary inside the cross-review prompt.
    const nasty = join(root, 'we"ird<repo>');
    mkdirSync(nasty, { recursive: true });
    const engine = makeEngine(nasty);

    const out = await engine.snippetsForFinding('See src/billing.ts:1');

    expect(out).toContain('but file not found');
    expect(out).toContain('weirdrepo');
    expect(out).not.toContain('<repo>');
    expect(out).not.toContain('we"ird');
  });

  it('never discloses the operator filesystem layout above a project root to the prompt (#748)', async () => {
    // Simulate an operator whose project lives several directories deep,
    // e.g. under a home directory — the intermediate segments (home dir
    // name, parent dirs) must never reach a cross-review prompt that a
    // relay-type reviewer forwards to a third-party LLM provider.
    const operatorTree = join(root, 'Users', 'someoperator', 'Desktop');
    const secretProject = join(operatorTree, 'secret-project-name');
    mkdirSync(secretProject, { recursive: true });
    const engine = makeEngine(secretProject);

    const out = await engine.snippetsForFinding('See src/billing.ts:1');

    expect(out).toContain('but file not found');
    // Only the basename is disclosed...
    expect(out).toContain('secret-project-name');
    // ...never the full absolute path or any parent segment.
    expect(out).not.toContain(secretProject);
    expect(out).not.toContain('someoperator');
    expect(out).not.toContain(join('Users', 'someoperator'));
  });
});
