/**
 * f8 follow-up (consensus dfe05be2-73794442:f8) — DIRECT timeout-synthesis seam.
 *
 * The PR-B §5 seam test in tests/orchestrator/round-context-producers.test.ts
 * REPRODUCED the timeout-path engine construction inline. This test drives the
 * REAL exported timeout-synthesis core
 * (apps/cli/src/handlers/relay-cross-review.ts → synthesizeTimeoutRound) so the
 * genuine outer layer (the function the timeout watcher invokes) feeds the
 * genuine inner layer (ConsensusEngine.generateCrossReviewPrompts →
 * synthesizeWithCrossReview), and asserts the boundary value
 * (snapshot.roundContext.resolutionRoots) reaches anchor CONTENT in the final
 * artifact — the true Test 21 pattern.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { synthesizeTimeoutRound, type TimeoutSynthesisSnapshot } from '../../apps/cli/src/handlers/relay-cross-review';
import { ctx } from '../../apps/cli/src/mcp-context';
import { makeRoundContext } from '@gossip/orchestrator';
import type { TaskEntry } from '@gossip/orchestrator';

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

describe('(§5/f8) REAL timeout-synthesis seam — synthesizeTimeoutRound drives roots into anchor content', () => {
  let tmp: string;
  let origMainAgent: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tmo-seam-'));
    origMainAgent = (ctx as any).mainAgent;
    (ctx as any).mainAgent = { getAgentConfig: () => undefined } as any;
  });

  afterEach(() => {
    (ctx as any).mainAgent = origMainAgent;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the round worktree root reaches anchor CONTENT in the cross-review prompts', async () => {
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt')));
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(wt, 'src'), { recursive: true });
    // The cited file exists in BOTH roots with DISTINCT content — the worktree
    // copy must win, proving the round's resolutionRoots actually drove
    // resolution (not the projectRoot fallback).
    writeFileSync(join(proj, 'src', 'target.ts'), 'export const v = "master-HEAD";');
    writeFileSync(join(wt, 'src', 'target.ts'), 'export const v = "worktree-branch";');

    const snapshot: TimeoutSynthesisSnapshot = {
      allResults: [
        completed('agent-a', finding('Issue A <cite tag="file">src/target.ts:1</cite>')),
        completed('agent-b', finding('Issue B <cite tag="file">src/target.ts:1</cite>')),
      ],
      relayCrossReviewEntries: [],
      nativeCrossReviewEntries: [],
      roundContext: makeRoundContext({ resolutionRoots: [wt], consensusId: 'cafef00d-feedface' }),
    };

    // Drive the REAL exported core — same function the timeout watcher calls.
    const { report, prompts } = await synthesizeTimeoutRound(
      snapshot,
      'cafef00d-feedface',
      ['agent-c'],
      makeLlm(),
      proj,
    );

    expect(report).toBeDefined();
    const all = prompts.map(p => `${p.system}\n${p.user}`).join('\n');
    // Boundary value observable in the FINAL artifact: the WORKTREE copy reached
    // anchor content, the master copy did NOT.
    expect(all).toContain('worktree-branch');
    expect(all).not.toContain('master-HEAD');

    // The function also persisted the report under the projectRoot we passed.
    const reportPath = join(proj, '.gossip', 'consensus-reports', 'cafef00d-feedface.json');
    expect(existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(persisted.id).toBe('cafef00d-feedface');
    expect(persisted.timedOut).toEqual(['agent-c']);
  });

  it('reconstructs a RoundContext from flat resolutionRoots when the snapshot lacks an embedded round', async () => {
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj2')));
    const wt = realpathSync(mkdtempSync(join(tmp, 'wt2')));
    mkdirSync(join(proj, 'src'), { recursive: true });
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'target.ts'), 'export const v = "master-HEAD";');
    writeFileSync(join(wt, 'src', 'target.ts'), 'export const v = "worktree-branch";');

    // Old pre-PR-A restored record: flat resolutionRoots, NO embedded round.
    const snapshot: TimeoutSynthesisSnapshot = {
      allResults: [
        completed('agent-a', finding('A <cite tag="file">src/target.ts:1</cite>')),
        completed('agent-b', finding('B <cite tag="file">src/target.ts:1</cite>')),
      ],
      relayCrossReviewEntries: [],
      nativeCrossReviewEntries: [],
      resolutionRoots: [wt],
    };

    const { prompts } = await synthesizeTimeoutRound(snapshot, 'aabbccdd-eeff0011', [], makeLlm(), proj);
    const all = prompts.map(p => `${p.system}\n${p.user}`).join('\n');
    expect(all).toContain('worktree-branch');
    expect(all).not.toContain('master-HEAD');
  });
});
