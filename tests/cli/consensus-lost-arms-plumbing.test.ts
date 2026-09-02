/**
 * Issue #738 — CLI-side plumbing for the lost-arm coverage denominator.
 *
 * The engine-level behavior is covered in
 * tests/orchestrator/consensus-coverage-lost-arms.test.ts. This file drives the
 * REAL CLI seams that feed it, because that is where the bug actually lived:
 * every caller pre-filters `allResults` to `status === 'completed'`, so the
 * dispatched-but-lost arm ids have to survive (a) the timeout-synthesis
 * snapshot and (b) a /mcp reconnect round-trip, or the denominator silently
 * falls back to arrivals-only.
 */
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  synthesizeTimeoutRound,
  persistPendingConsensus,
  restorePendingConsensus,
  type TimeoutSynthesisSnapshot,
} from '../../apps/cli/src/handlers/relay-cross-review';
import { ctx } from '../../apps/cli/src/mcp-context';
import { parseCoverageDegradedMessage } from '../../packages/orchestrator/src/coverage-degraded';
import type { TaskEntry } from '@gossip/orchestrator';

const makeLlm = (): any => ({
  generate: jest.fn(async () => ({ text: '[]', usage: { inputTokens: 0, outputTokens: 0 } })),
});

const completed = (agentId: string, result: string): TaskEntry => ({
  id: `t-${agentId}`, agentId, task: 'review X', status: 'completed', result, startedAt: Date.now(),
}) as TaskEntry;

const finding = (text: string) =>
  `<agent_finding type="finding" severity="high" category="data_integrity">${text}</agent_finding>`;

describe('#738 — synthesizeTimeoutRound carries lostAgents into the coverage denominator', () => {
  let tmp: string;
  let origMainAgent: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lost-arm-'));
    origMainAgent = (ctx as any).mainAgent;
    (ctx as any).mainAgent = { getAgentConfig: () => undefined } as any;
  });

  afterEach(() => {
    (ctx as any).mainAgent = origMainAgent;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a 3-arm round with 1 timed-out arm reports 2/3, not 2/2', async () => {
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj')));
    const snapshot: TimeoutSynthesisSnapshot = {
      allResults: [
        completed('agent-a', finding('Missing token validation in auth.ts:10 allows bypass')),
        completed('agent-b', finding('Missing input validation in router.ts:22 for user query')),
      ],
      // agent-c was dispatched into the round and never came back — it is
      // absent from allResults by construction (completed-only snapshot).
      lostAgents: ['agent-c'],
      relayCrossReviewEntries: [],
      nativeCrossReviewEntries: [],
    };

    const { report } = await synthesizeTimeoutRound(
      snapshot, 'aaaabbbb-ccccdddd', ['agent-c'], makeLlm(), proj,
    );

    const signal = report.signals.find((s: any) => s.signal === 'consensus_coverage_degraded');
    expect(signal).toBeDefined();
    expect(parseCoverageDegradedMessage(signal!.evidence!)).toEqual({
      received: 2, expected: 3, droppedAgents: ['agent-c'],
    });
  });

  it('an all-arrived round still reports no degradation through the same seam', async () => {
    const proj = realpathSync(mkdtempSync(join(tmp, 'proj2')));
    const snapshot: TimeoutSynthesisSnapshot = {
      allResults: [
        completed('agent-a', finding('Missing token validation in auth.ts:10 allows bypass')),
        completed('agent-b', finding('Missing input validation in router.ts:22 for user query')),
      ],
      lostAgents: [],
      relayCrossReviewEntries: [],
      nativeCrossReviewEntries: [],
    };

    const { report } = await synthesizeTimeoutRound(
      snapshot, 'eeeeffff-00001111', [], makeLlm(), proj,
    );

    expect(report.signals.find((s: any) => s.signal === 'consensus_coverage_degraded')).toBeUndefined();
  });
});

describe('#738 — PendingConsensusRound.lostAgents survives a reconnect round-trip', () => {
  let tmp: string;
  let origMainAgent: any;

  // NOTE: deliberately no process.chdir here. Both functions take their root
  // explicitly (persist via ctx.mainAgent.projectRoot, restore via argument),
  // and chdir mutates worker-global state that sibling suites reading relative
  // paths in the same jest worker can observe.
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lost-arm-persist-'));
    mkdirSync(join(tmp, '.gossip'), { recursive: true });
    origMainAgent = (ctx as any).mainAgent;
    (ctx as any).mainAgent = { projectRoot: tmp } as any;
  });

  afterEach(() => {
    ctx.pendingConsensusRounds.clear();
    (ctx as any).mainAgent = origMainAgent;
    rmSync(tmp, { recursive: true, force: true });
  });

  const baseRound = (id: string, lostAgents?: string[]) => ({
    consensusId: id,
    allResults: [],
    ...(lostAgents !== undefined ? { lostAgents } : {}),
    relayCrossReviewEntries: [],
    pendingNativeAgents: new Set(['sonnet']),
    participatingNativeAgents: new Set(['sonnet']),
    nativeCrossReviewEntries: [],
    deadline: Date.now() + 600_000,
    createdAt: Date.now(),
  }) as any;

  it('persists and restores the lost-arm ids', () => {
    const roundId = '11112222-33334444';
    ctx.pendingConsensusRounds.set(roundId, baseRound(roundId, ['agent-c', 'agent-d']));
    persistPendingConsensus();

    ctx.pendingConsensusRounds.clear();
    restorePendingConsensus(tmp);

    expect(ctx.pendingConsensusRounds.get(roundId)!.lostAgents).toEqual(['agent-c', 'agent-d']);
  });

  it('restores undefined for a round persisted before #738 (back-compat)', () => {
    const roundId = '55556666-77778888';
    ctx.pendingConsensusRounds.set(roundId, baseRound(roundId));
    persistPendingConsensus();

    ctx.pendingConsensusRounds.clear();
    restorePendingConsensus(tmp);

    expect(ctx.pendingConsensusRounds.get(roundId)!.lostAgents).toBeUndefined();
  });
});
