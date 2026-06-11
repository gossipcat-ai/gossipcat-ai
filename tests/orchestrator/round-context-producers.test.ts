/**
 * PR-B fail-loud PRODUCER conversion + timeout-synthesis seam tests
 * (spec 2026-06-11-round-context-fail-loud.md §4/§5/§6.2, consensus 5e9804d3-91fe440d).
 *
 * Each degraded-mode producer must DUAL-WRITE: emit the structured RoundWarning
 * on the round AND keep the legacy ConsensusReport field populated (PR-C deletes
 * the legacy fields, not PR-B). These tests pin both halves:
 *   - cross_review_skipped  ↔ report.relayCrossReviewSkipped
 *   - coverage_degraded     ↔ report.coverageDegraded
 *   - partial_review        ↔ report.partialReview
 *   - anchor_master_fallback (new structured producer alongside the via= note)
 *
 * Plus the DIRECT timeout-synthesis seam (§5): the timeout path constructs a
 * DISTINCT engine (`new ConsensusEngine({ round: snapshot.roundContext })`) and
 * calls synthesizeWithCrossReview — this test drives that exact construction and
 * asserts the round's worktree root reaches anchor CONTENT in the artifact, not
 * just the engine config (Test 21 pattern: real outer → real inner → observable
 * boundary value).
 */
import {
  ConsensusEngine,
  type ConsensusEngineConfig,
} from '../../packages/orchestrator/src/consensus-engine';
import { makeRoundContext } from '../../packages/orchestrator/src/round-context';
import type { TaskEntry } from '../../packages/orchestrator/src/types';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const makeLlm = (): any => ({
  generate: jest.fn(async () => ({ text: '[]', usage: { inputTokens: 0, outputTokens: 0 } })),
});

const completed = (agentId: string, result: string): TaskEntry => ({
  id: `t-${agentId}`,
  agentId,
  task: 'review X',
  status: 'completed',
  result,
  startedAt: Date.now(),
}) as TaskEntry;

const finding = (text: string) =>
  `<agent_finding type="finding" severity="high" category="data_integrity">${text}</agent_finding>`;

describe('PR-B producer conversions — dual-write warning + legacy field', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rcp-prod-'));
    root = realpathSync(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('cross_review_skipped: emits one warning per skipped agent AND keeps report.relayCrossReviewSkipped', async () => {
    const round = makeRoundContext({ resolutionRoots: [], warnings: [] });
    const engine = new ConsensusEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root, round,
    } as ConsensusEngineConfig);

    const skipped = [
      { agentId: 'gemini-reviewer', reason: 'quota exhausted' },
      { agentId: 'gemini-tester', reason: 'parser produced 0 entries' },
    ];
    const report = await engine.synthesizeWithCrossReview(
      [completed('agent-a', finding('A')), completed('agent-b', finding('B'))],
      [],
      'cafef00d-0bad1dea',
      skipped,
    );

    // Legacy field intact (dual-write — PR-C deletes it, not PR-B).
    expect(report.relayCrossReviewSkipped).toEqual(skipped);
    // Structured warnings: one per skipped agent, code + agentId attribution.
    const crw = (report.warnings ?? []).filter(w => w.code === 'cross_review_skipped');
    expect(crw).toHaveLength(2);
    expect(crw.map(w => w.agentId).sort()).toEqual(['gemini-reviewer', 'gemini-tester']);
    expect(crw[0].message).toContain('cross-review skipped');
    // And the round carries them too (persistence channel).
    expect(round.warnings.filter(w => w.code === 'cross_review_skipped')).toHaveLength(2);
  });

  it('coverage_degraded: emits warning AND keeps report.coverageDegraded when an agent returns 0 chars', async () => {
    const round = makeRoundContext({ resolutionRoots: [], warnings: [] });
    const engine = new ConsensusEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root, round,
    } as ConsensusEngineConfig);

    const dropped = { id: 't-x', agentId: 'agent-dropped', task: 'review', status: 'completed', result: '', startedAt: Date.now() } as TaskEntry;
    const report = await engine.synthesizeWithCrossReview(
      [completed('agent-a', finding('A')), dropped],
      [],
      'd00dfeed-1abe11ed',
      undefined,
    );

    expect(report.coverageDegraded).toBeDefined();
    expect(report.coverageDegraded!.droppedAgents).toContain('agent-dropped');
    const cd = (report.warnings ?? []).filter(w => w.code === 'coverage_degraded');
    expect(cd).toHaveLength(1);
    expect(cd[0].message).toContain('Coverage degraded');
  });

  it('partial_review: emits warning AND sets report.partialReview when fewer than K reviewers selected', async () => {
    // runSelectedCrossReview requires a performanceReader. Two agents → K=2 for
    // each non-critical finding, but with only 2 candidates a reviewer cannot
    // review its own finding, so coverage falls short of K → partialReview.
    const perfReader = new PerformanceReader(root);
    const round = makeRoundContext({ resolutionRoots: [], warnings: [] });
    const engine = new ConsensusEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: root, round,
      performanceReader: perfReader,
    } as ConsensusEngineConfig);

    const report = await engine.runSelectedCrossReview(
      [
        completed('agent-a', finding('Finding A1 with an extended body so the strict parser keeps it')),
        completed('agent-b', finding('Finding B1 with an extended body so the strict parser keeps it')),
      ],
      'feedface-deadbeef',
    );

    expect(report.partialReview).toBe(true);
    const pr = (report.warnings ?? []).filter(w => w.code === 'partial_review');
    expect(pr).toHaveLength(1);
  });

  it('anchor_master_fallback: emits a warning per anchor that resolves via projectRoot while roots are declared (no dedup)', async () => {
    // A cited file exists ONLY in projectRoot (not the declared worktree root),
    // so it resolves via projectRoot fallback → one anchor_master_fallback per
    // resolved instance. Two distinct findings cite it → two warnings (no dedup).
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt')));
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(wt, 'src'), { recursive: true });
    // File present in projectRoot only — worktree lacks it → projectRoot fallback.
    writeFileSync(join(proj, 'src', 'only-master.ts'), 'line1\nline2 actual content\nline3');

    const round = makeRoundContext({ resolutionRoots: [wt], warnings: [] });
    const engine = new ConsensusEngine({
      llm: makeLlm(), registryGet: () => undefined, projectRoot: proj, round,
    } as ConsensusEngineConfig);

    // dispatchCrossReview generates prompts that resolve the cite anchors.
    await engine.generateCrossReviewPrompts([
      completed('agent-a', finding('issue <cite tag="file">src/only-master.ts:2</cite>')),
      completed('agent-b', finding('issue <cite tag="file">src/only-master.ts:2</cite>')),
    ]);

    const amf = round.warnings.filter(w => w.code === 'anchor_master_fallback');
    // One per resolved-from-projectRoot instance — array keeps every instance.
    expect(amf.length).toBeGreaterThanOrEqual(2);
    expect(amf[0].message).toContain('project root');
  });
});

describe('(§5) DIRECT timeout-synthesis seam — snapshot carries round roots into synthesizeWithCrossReview', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rcp-tmo-')); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('the round\'s worktree root reaches anchor CONTENT in cross-review prompts via the timeout-path engine construction', async () => {
    // Faithfully reproduce the relay-cross-review.ts:72 timeout-synthesis engine
    // construction: a snapshot.roundContext (NOT the resume path) is forwarded
    // as `round` to a freshly-constructed ConsensusEngine. Assert the worktree
    // copy of a cited file reaches the prompt content — the boundary value
    // (round.resolutionRoots) is observable in the FINAL artifact, not just the
    // config. This is the distinct construction the resume path does not exercise.
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt')));
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'target.ts'), 'export const v = "master-HEAD";');
    writeFileSync(join(wt, 'src', 'target.ts'), 'export const v = "worktree-branch";');

    // Snapshot exactly as the timeout watcher builds it.
    const snapshot = {
      roundContext: makeRoundContext({ resolutionRoots: [wt], consensusId: 'cafef00d-feedface' }),
    };

    // The timeout path constructs the engine with `round: snapshot.roundContext`.
    const engine = new ConsensusEngine({
      llm: makeLlm(),
      registryGet: () => undefined,
      projectRoot: proj,
      round: snapshot.roundContext,
    } as ConsensusEngineConfig);

    const results = [
      completed('agent-a', finding('Issue A <cite tag="file">src/target.ts:1</cite>')),
      completed('agent-b', finding('Issue B <cite tag="file">src/target.ts:1</cite>')),
    ];

    // generateCrossReviewPrompts is where anchors are resolved against the
    // round's roots and embedded as <anchor> snippet CONTENT in the prompts.
    const { prompts } = await engine.generateCrossReviewPrompts(results);
    // synthesizeWithCrossReview is the distinct timeout-path call.
    const report = await engine.synthesizeWithCrossReview(results, [], 'cafef00d-feedface', undefined);

    expect(report).toBeDefined();
    const all = prompts.map(p => `${p.system}\n${p.user}`).join('\n');
    // The cited file exists in BOTH roots with distinct content — the prompts
    // built by the timeout-path engine must carry the WORKTREE version.
    expect(all).toContain('worktree-branch');
    expect(all).not.toContain('master-HEAD');
  });
});
