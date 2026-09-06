/**
 * Issue #737 direction 3 — flag a cwd that is not a real project root BEFORE a
 * citation-bearing ConsensusEngine starts resolving anchors against it.
 *
 * `projectRoot: process.cwd()` is threaded into every ConsensusEngine with no
 * check that the cwd is actually the project under review. When one relay
 * process serves several repos, the resolver silently anchors at whichever repo
 * happened to be cwd at startup and the failure surfaces much later as a wall
 * of "file not found" citations. `warnIfNotProjectRoot` makes that condition
 * loud at dispatch time — and deliberately does NOT throw, because anchor
 * resolution is a review-quality enhancement, not a precondition for consensus.
 */
import { warnIfNotProjectRoot, findConfigPath, __resetProjectRootWarnings } from '../../apps/cli/src/config';
import { synthesizeTimeoutRound, type TimeoutSynthesisSnapshot } from '../../apps/cli/src/handlers/relay-cross-review';
import { ctx } from '../../apps/cli/src/mcp-context';
import { makeRoundContext } from '@gossip/orchestrator';
import type { TaskEntry } from '@gossip/orchestrator';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

describe('warnIfNotProjectRoot (#737)', () => {
  let tmp: string;
  let root: string;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'prs-'));
    root = realpathSync(tmp);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    __resetProjectRootWarnings();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetProjectRootWarnings();
    rmSync(tmp, { recursive: true, force: true });
  });

  const warnings = (): string[] =>
    warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('project-root sanity check'));

  it('warns loudly (and does not throw) when the root holds no gossipcat config', () => {
    const notARoot = join(root, 'random-dir');
    mkdirSync(notARoot);
    expect(findConfigPath(notARoot)).toBeNull();

    expect(warnIfNotProjectRoot(notARoot, 'gossip_collect cross-review')).toBe(false);

    const msgs = warnings();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(notARoot);
    expect(msgs[0]).toContain('gossip_collect cross-review');
    // The message must explain the downstream consequence, so the operator can
    // connect it to the "file not found" citations they will see later.
    expect(msgs[0]).toContain('file not found');
  });

  it('stays silent for a real project root (.gossip/config.json)', () => {
    const realRoot = join(root, 'project');
    mkdirSync(join(realRoot, '.gossip'), { recursive: true });
    writeFileSync(join(realRoot, '.gossip', 'config.json'), '{}');

    expect(warnIfNotProjectRoot(realRoot)).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it('accepts the legacy gossip.agents.json root form', () => {
    const legacyRoot = join(root, 'legacy');
    mkdirSync(legacyRoot);
    writeFileSync(join(legacyRoot, 'gossip.agents.json'), '{}');

    expect(warnIfNotProjectRoot(legacyRoot)).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it('reports a given bad root once, not once per dispatch', () => {
    const notARoot = join(root, 'noisy');
    mkdirSync(notARoot);

    warnIfNotProjectRoot(notARoot);
    warnIfNotProjectRoot(notARoot);
    warnIfNotProjectRoot(notARoot);

    expect(warnings()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // Issue #747 — config-presence alone only rules out "no project", never
  // "the WRONG project". A relay sitting in project A's real root passed the
  // check silently while synthesizing a round that belongs to project B.
  // ---------------------------------------------------------------------

  const makeProject = (name: string, agentIds: string[]): string => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    writeFileSync(
      join(dir, '.gossip', 'config.json'),
      JSON.stringify({
        main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        agents: Object.fromEntries(
          agentIds.map((id) => [id, { provider: 'anthropic', model: 'claude-sonnet-4-6', skills: [] }]),
        ),
      }),
    );
    return dir;
  };

  it('warns when the root IS a gossipcat project but a different one than the round', () => {
    // Project A is a perfectly real gossipcat root — findConfigPath succeeds.
    const otherProject = makeProject('project-a', ['a-reviewer', 'a-researcher']);
    expect(findConfigPath(otherProject)).not.toBeNull();

    // ...but the round being synthesized belongs to project B entirely.
    expect(
      warnIfNotProjectRoot(otherProject, 'gossip_collect cross-review', ['b-reviewer', 'b-implementer']),
    ).toBe(false);

    const msgs = warnings();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(otherProject);
    expect(msgs[0]).toContain('different project');
    expect(msgs[0]).toContain('b-reviewer');
    // Same downstream consequence as the no-config case, so the operator can
    // connect it to the "file not found" citations they will see later.
    expect(msgs[0]).toContain('file not found');
  });

  it('stays silent when even one round agent is registered in the found config', () => {
    const project = makeProject('project-overlap', ['a-reviewer', 'a-researcher']);

    expect(warnIfNotProjectRoot(project, 'consensus', ['a-researcher', 'guest-agent'])).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it('keeps the pre-#747 behavior when no round agent IDs are supplied', () => {
    const project = makeProject('project-legacy-caller', ['a-reviewer']);

    expect(warnIfNotProjectRoot(project)).toBe(true);
    expect(warnIfNotProjectRoot(project, 'consensus', [])).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it('fails open (silent) when the found config declares no agents at all', () => {
    // `{}` is the shape the pre-existing tests above use. Absent evidence must
    // never be read as "zero overlap" — that would warn on every fresh install.
    const bare = join(root, 'project-no-agents');
    mkdirSync(join(bare, '.gossip'), { recursive: true });
    writeFileSync(join(bare, '.gossip', 'config.json'), '{}');

    expect(warnIfNotProjectRoot(bare, 'consensus', ['b-reviewer'])).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it('fails open (silent) when the found config is unparseable', () => {
    const broken = join(root, 'project-broken-config');
    mkdirSync(join(broken, '.gossip'), { recursive: true });
    writeFileSync(join(broken, '.gossip', 'config.json'), '{ this is not json');

    expect(() => warnIfNotProjectRoot(broken, 'consensus', ['b-reviewer'])).not.toThrow();
    expect(warnIfNotProjectRoot(broken, 'consensus', ['b-reviewer'])).toBe(true);
    expect(warnings()).toHaveLength(0);
  });

  it('reports each distinct bad root separately', () => {
    const a = join(root, 'bad-a');
    const b = join(root, 'bad-b');
    mkdirSync(a);
    mkdirSync(b);

    warnIfNotProjectRoot(a);
    warnIfNotProjectRoot(b);

    const msgs = warnings();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain(a);
    expect(msgs[1]).toContain(b);
  });
});

/**
 * The reported scenario end-to-end, through the REAL exported timeout-synthesis
 * core: a citation-bearing round whose projectRoot is some other directory.
 * Both halves of the fix must be observable in one pass — the dispatch-time
 * sanity warning AND the reviewer-facing annotation that names the searched
 * roots.
 */
describe('citation-bearing round anchored at the wrong project root (#737)', () => {
  let tmp: string;
  let origMainAgent: any;
  let warnSpy: jest.SpyInstance;

  const makeLlm = (): any => ({
    generate: jest.fn(async () => ({ text: '[]', usage: { inputTokens: 0, outputTokens: 0 } })),
  });

  const completed = (agentId: string, result: string): TaskEntry => ({
    id: `t-${agentId}`,
    agentId,
    task: 'review billing',
    status: 'completed',
    result,
    startedAt: Date.now(),
  }) as TaskEntry;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'prs-e2e-'));
    origMainAgent = (ctx as any).mainAgent;
    (ctx as any).mainAgent = { getAgentConfig: () => undefined } as any;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    __resetProjectRootWarnings();
  });

  afterEach(() => {
    (ctx as any).mainAgent = origMainAgent;
    warnSpy.mockRestore();
    __resetProjectRootWarnings();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('warns about the bad root once and names it in the cross-review annotation', async () => {
    // The relay's cwd-equivalent: a directory with no gossipcat config that does
    // NOT contain the cited file.
    const wrongRoot = realpathSync(mkdtempSync(join(tmp, 'other-repo')));
    // The repo the citation actually belongs to — never searched.
    const realRepo = realpathSync(mkdtempSync(join(tmp, 'real-repo')));
    mkdirSync(join(realRepo, 'src'), { recursive: true });
    writeFileSync(join(realRepo, 'src', 'billing.ts'), 'export const rate = 1;');

    const snapshot: TimeoutSynthesisSnapshot = {
      allResults: [
        completed('agent-a', '<agent_finding type="finding" severity="high">Rate bug <cite tag="file">src/billing.ts:1</cite> and src/billing.ts:1</agent_finding>'),
        completed('agent-b', '<agent_finding type="finding" severity="high">Same rate bug at src/billing.ts:1</agent_finding>'),
      ],
      relayCrossReviewEntries: [],
      nativeCrossReviewEntries: [],
      roundContext: makeRoundContext({ resolutionRoots: [], consensusId: 'deadbeef-0badf00d' }),
    };

    const { prompts } = await synthesizeTimeoutRound(
      snapshot,
      'deadbeef-0badf00d',
      [],
      makeLlm(),
      wrongRoot,
    );

    // (3) dispatch-time sanity warning fired exactly once for the bad root.
    const sanity = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('project-root sanity check'));
    expect(sanity).toHaveLength(1);
    expect(sanity[0]).toContain(wrongRoot);

    // (2) the resolver's own root list is visible once, not per citation.
    const rootLogs = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('anchor resolution roots for this round'));
    expect(rootLogs).toHaveLength(1);
    expect(rootLogs[0]).toContain(`projectRoot=${wrongRoot}`);

    // (1) the reviewer-facing prompt distinguishes "wrong root" from "bad citation".
    // The prompt reaches relay-type reviewers backed by a third-party LLM
    // provider, so only the basename is disclosed there — never the full
    // absolute path (issue #748). The full path is fine in (2)/(3) above,
    // which are local-only console.warn output.
    const all = prompts.map((p) => `${p.system}\n${p.user}`).join('\n');
    expect(all).toContain('but file not found');
    expect(all).toContain(basename(wrongRoot));
    expect(all).not.toContain(wrongRoot);
    expect(all).toContain('anchored to the wrong project');
    expect(all).not.toContain(realRepo);
  });

  // Issue #747: the reported shape. The relay's cwd is a REAL gossipcat project
  // root, so the #737 config-presence check passed silently — but it is some
  // other project's root, and the round under synthesis knows nothing about the
  // agents it registers.
  it('warns when the synthesis root is another real gossipcat project', async () => {
    const otherProject = realpathSync(mkdtempSync(join(tmp, 'other-project')));
    mkdirSync(join(otherProject, '.gossip'), { recursive: true });
    writeFileSync(
      join(otherProject, '.gossip', 'config.json'),
      JSON.stringify({
        main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        agents: {
          'unrelated-reviewer': { provider: 'anthropic', model: 'claude-sonnet-4-6', skills: [] },
        },
      }),
    );

    const snapshot: TimeoutSynthesisSnapshot = {
      allResults: [
        completed('agent-a', '<agent_finding type="finding" severity="high">Rate bug at src/billing.ts:1</agent_finding>'),
        completed('agent-b', '<agent_finding type="finding" severity="high">Same rate bug at src/billing.ts:1</agent_finding>'),
      ],
      relayCrossReviewEntries: [],
      nativeCrossReviewEntries: [],
      roundContext: makeRoundContext({ resolutionRoots: [], consensusId: 'deadbeef-0badf00d' }),
    };

    await synthesizeTimeoutRound(snapshot, 'deadbeef-0badf00d', [], makeLlm(), otherProject);

    const sanity = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('project-root sanity check'));
    expect(sanity).toHaveLength(1);
    expect(sanity[0]).toContain(otherProject);
    expect(sanity[0]).toContain('different project');
    expect(sanity[0]).toContain('agent-a');
  });
});
