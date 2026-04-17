/**
 * Regression tests for GH #131 — the self-review filter in
 * handleRelayCrossReview dropped every NEW entry because agents naturally
 * emit findingId "<self>:n<N>" (no peer to reference), which matched the
 * `peerAgentId === agent_id` guard.
 *
 * Fix invariants:
 *   1. NEW entries survive the filter regardless of peerAgentId.
 *   2. NEW findingIds are rewritten to `<consensusId>:new:<agentId>:<counter>`.
 *   3. Self-AGREE still rejected (no regression on the peer-ID guard).
 */
import { handleRelayCrossReview } from '../../apps/cli/src/handlers/relay-cross-review';
import { ctx } from '../../apps/cli/src/mcp-context';
import { MainAgent } from '@gossip/orchestrator';

// Avoid disk writes from persistPendingConsensus during the test.
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  existsSync: jest.fn(() => false),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

const CONSENSUS_ID = 'cafecafe-beefbeef';
const AGENT_ID = 'my-agent-id';
const PEER_ID = 'peer-agent';

function seedRound(pendingSet: Set<string>) {
  ctx.pendingConsensusRounds.set(CONSENSUS_ID, {
    consensusId: CONSENSUS_ID,
    allResults: [
      { agentId: AGENT_ID, status: 'completed', result: '- Phase-1 finding', task: 't' },
      { agentId: PEER_ID, status: 'completed', result: '- Peer finding', task: 't' },
    ],
    relayCrossReviewEntries: [],
    relayCrossReviewSkipped: undefined,
    pendingNativeAgents: pendingSet,
    nativeCrossReviewEntries: [],
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    nativePrompts: [],
  });
}

describe('relay-cross-review NEW-finding handling (GH #131)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ctx.pendingConsensusRounds.clear();

    // ConsensusEngine needs a MainAgent-like stub for parseCrossReviewResponse.
    // parseCrossReviewResponse does not call the LLM, but the engine ctor
    // still requires one — handler supplies a no-op when getLlm() returns
    // undefined, so we mirror that here.
    ctx.mainAgent = {
      projectRoot: '/tmp/relay-cross-review-test',
      getLlm: () => undefined,
      getAgentConfig: () => undefined,
    } as unknown as MainAgent;
  });

  it('accepts a NEW entry with self-prefixed findingId and rewrites it to the consensus-wide form', async () => {
    // Two pending agents so this submission does NOT trigger synthesis (which
    // would require a real LLM). We only assert the filter+rewrite step.
    seedRound(new Set([AGENT_ID, PEER_ID]));

    const payload = JSON.stringify([
      {
        action: 'new',
        findingId: `${AGENT_ID}:n1`, // self-prefixed — this is what agents emit
        finding: 'A totally new issue all agents missed',
        evidence: 'Surfaced after reading peer work at foo.ts:42',
        confidence: 4,
      },
    ]);

    const res = await handleRelayCrossReview(CONSENSUS_ID, AGENT_ID, payload);

    const round = ctx.pendingConsensusRounds.get(CONSENSUS_ID)!;
    expect(round.nativeCrossReviewEntries).toHaveLength(1);
    const entry = round.nativeCrossReviewEntries[0];
    expect(entry.action).toBe('new');
    expect(entry.agentId).toBe(AGENT_ID);
    expect(entry.finding).toContain('A totally new issue');
    // findingId rewritten to `<consensusId>:new:<agentId>:<counter>`
    expect(entry.findingId).toBe(`${CONSENSUS_ID}:new:${AGENT_ID}:1`);
    // peerAgentId cleared — NEW has no peer
    expect(entry.peerAgentId).toBe('');

    const txt = (res.content[0] as { text: string }).text;
    expect(txt).toContain('accepted');
  });

  it('rejects a self-prefixed AGREE entry (no regression on the peer-ID filter)', async () => {
    seedRound(new Set([AGENT_ID, PEER_ID]));

    const payload = JSON.stringify([
      {
        action: 'agree',
        findingId: `${AGENT_ID}:f1`, // self-review, not allowed
        finding: 'I confirm my own Phase-1 finding',
        evidence: 'self-verification is not valid cross-review',
        confidence: 5,
      },
    ]);

    await handleRelayCrossReview(CONSENSUS_ID, AGENT_ID, payload);

    const round = ctx.pendingConsensusRounds.get(CONSENSUS_ID)!;
    // Self-AGREE must be dropped by the filter.
    expect(round.nativeCrossReviewEntries).toHaveLength(0);
  });

  it('assigns independent counters to multiple NEW findings in one submission', async () => {
    seedRound(new Set([AGENT_ID, PEER_ID]));

    const payload = JSON.stringify([
      { action: 'new', findingId: 'self:n1', finding: 'NEW one at a.ts:1', evidence: 'e1', confidence: 3 },
      { action: 'new', findingId: 'self:n2', finding: 'NEW two at b.ts:2', evidence: 'e2', confidence: 3 },
    ]);

    await handleRelayCrossReview(CONSENSUS_ID, AGENT_ID, payload);

    const round = ctx.pendingConsensusRounds.get(CONSENSUS_ID)!;
    expect(round.nativeCrossReviewEntries).toHaveLength(2);
    expect(round.nativeCrossReviewEntries[0].findingId).toBe(`${CONSENSUS_ID}:new:${AGENT_ID}:1`);
    expect(round.nativeCrossReviewEntries[1].findingId).toBe(`${CONSENSUS_ID}:new:${AGENT_ID}:2`);
  });
});
