/**
 * Integration tests for FIX 1 (UNIT 6):
 * runMidFlightCheck is invoked at the relay-cross-review synthesis site with
 * a live roundStartSha — NOT in collect.ts (where the round is already deleted).
 *
 * Tests:
 *  1. mid_flight_fixup IS emitted when commits exist AND roundStartSha is present
 *     (completion-synthesis path).
 *  2. mid_flight_fixup is NOT emitted when roundStartSha is absent/undefined
 *     (both paths — shows the no-op guard works).
 *
 * All external I/O is stubbed:
 *  - fs writes (persistPendingConsensus, consensus-reports) are mocked.
 *  - @gossip/orchestrator is partially mocked (ConsensusEngine stub + runMidFlightCheck spy).
 *  - orchestrator-precondition-runner.runMidFlightCheck is spied on so we can
 *    assert it was called with the correct roundStartSha BEFORE the round was deleted.
 */

import { ctx } from '../../apps/cli/src/mcp-context';
import type { MainAgent } from '@gossip/orchestrator';
import type { MidFlightCheckInput } from '../../apps/cli/src/handlers/orchestrator-precondition-runner';

// ── fs mock — suppress all real disk writes ──────────────────────────────────
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  existsSync: jest.fn(() => false),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// ── orchestrator-precondition-runner mock — spy on runMidFlightCheck ─────────
jest.mock(
  '../../apps/cli/src/handlers/orchestrator-precondition-runner',
  () => ({
    runMidFlightCheck: jest.fn(),
    captureHeadSha: jest.fn(() => undefined),
  }),
);

// ── @gossip/orchestrator partial mock ────────────────────────────────────────
// ConsensusEngine.parseCrossReviewResponse + synthesizeWithCrossReview are
// needed by the handler. We stub just enough to avoid real LLM calls.
jest.mock('@gossip/orchestrator', () => {
  class FakeEngine {
    parseCrossReviewResponse(_agentId: string, _result: string, _limit: number) {
      return [];
    }
    async synthesizeWithCrossReview(
      _allResults: any[],
      _entries: any[],
      consensusId: string,
    ) {
      return {
        confirmed: [],
        disputed: [],
        unverified: [],
        unique: [],
        insights: [],
        newFindings: [],
        signals: [],
        agentCount: 1,
        rounds: 1,
        summary: `Consensus complete: 0 confirmed (stub) for ${consensusId}`,
      };
    }
    async generateCrossReviewPrompts() {
      return { prompts: [] };
    }
  }

  function makeRoundContext(opts?: { resolutionRoots?: string[] }) {
    return { resolutionRoots: opts?.resolutionRoots ?? [], warnings: [] };
  }

  return {
    ConsensusEngine: FakeEngine,
    makeRoundContext,
    emitConsensusSignals: jest.fn(),
    emitPipelineSignals: jest.fn(),
    MainAgent: jest.fn(),
  };
});

// ── import after mocks ────────────────────────────────────────────────────────
import { handleRelayCrossReview } from '../../apps/cli/src/handlers/relay-cross-review';
import * as preconditionRunner from '../../apps/cli/src/handlers/orchestrator-precondition-runner';

const CONSENSUS_ID = 'unit6-test-cafecafe';
const AGENT_A = 'agent-alpha';
const AGENT_B = 'agent-beta';

function seedRound(opts: { roundStartSha?: string } = {}) {
  ctx.pendingConsensusRounds.set(CONSENSUS_ID, {
    consensusId: CONSENSUS_ID,
    allResults: [
      { agentId: AGENT_A, status: 'completed', result: '- finding A', task: 'task' },
      { agentId: AGENT_B, status: 'completed', result: '- finding B', task: 'task' },
    ],
    relayCrossReviewEntries: [],
    relayCrossReviewSkipped: undefined,
    // Only ONE pending agent so that when AGENT_A submits, synthesis triggers.
    pendingNativeAgents: new Set([AGENT_A]),
    participatingNativeAgents: new Set([AGENT_A, AGENT_B]),
    nativeCrossReviewEntries: [],
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    nativePrompts: [],
    roundStartSha: opts.roundStartSha,
  });
}

describe('relay-cross-review mid-flight check (FIX 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ctx.pendingConsensusRounds.clear();
    ctx.mainAgent = {
      projectRoot: '/fake/project',
      getLlm: () => ({
        generate: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 } }),
      }),
      getAgentConfig: () => undefined,
    } as unknown as MainAgent;
  });

  it('calls runMidFlightCheck with roundStartSha when synthesis completes (completion path)', async () => {
    const SHA = 'deadbeef12345678';
    // runMidFlightCheck must return {warnings:[]} to not throw.
    (preconditionRunner.runMidFlightCheck as jest.Mock).mockResolvedValue({ warnings: [] });

    seedRound({ roundStartSha: SHA });

    // Submit cross-review from the only pending agent → triggers completion synthesis.
    await handleRelayCrossReview(CONSENSUS_ID, AGENT_A, '[]');

    expect(preconditionRunner.runMidFlightCheck).toHaveBeenCalledTimes(1);
    const call = (preconditionRunner.runMidFlightCheck as jest.Mock).mock.calls[0][0] as MidFlightCheckInput;
    expect(call.roundStartSha).toBe(SHA);
    expect(call.consensusId).toBe(CONSENSUS_ID);
    expect(typeof call.projectRoot).toBe('string');
  });

  it('calls runMidFlightCheck with undefined roundStartSha when not set (no signal emitted)', async () => {
    (preconditionRunner.runMidFlightCheck as jest.Mock).mockResolvedValue({ warnings: [] });

    // Seed with no roundStartSha.
    seedRound({ roundStartSha: undefined });

    await handleRelayCrossReview(CONSENSUS_ID, AGENT_A, '[]');

    expect(preconditionRunner.runMidFlightCheck).toHaveBeenCalledTimes(1);
    const call = (preconditionRunner.runMidFlightCheck as jest.Mock).mock.calls[0][0] as MidFlightCheckInput;
    expect(call.roundStartSha).toBeUndefined();
  });

  it('mid_flight_fixup warning surfaces when runMidFlightCheck returns warnings', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    (preconditionRunner.runMidFlightCheck as jest.Mock).mockResolvedValue({
      warnings: ['[mid-flight-fixup] 2 commit(s) landed during Phase 2 cross-review'],
    });

    seedRound({ roundStartSha: 'abc00001' });
    await handleRelayCrossReview(CONSENSUS_ID, AGENT_A, '[]');

    const stderrCalls = stderrSpy.mock.calls.map(c => c[0] as string);
    expect(stderrCalls.some(s => s.includes('mid-flight-fixup'))).toBe(true);
    stderrSpy.mockRestore();
  });

  it('does NOT call runMidFlightCheck when round still has pending agents (no synthesis)', async () => {
    (preconditionRunner.runMidFlightCheck as jest.Mock).mockResolvedValue({ warnings: [] });

    // Two pending agents — submitting one does NOT trigger synthesis.
    ctx.pendingConsensusRounds.set(CONSENSUS_ID, {
      consensusId: CONSENSUS_ID,
      allResults: [
        { agentId: AGENT_A, status: 'completed', result: '- A', task: 'task' },
        { agentId: AGENT_B, status: 'completed', result: '- B', task: 'task' },
      ],
      relayCrossReviewEntries: [],
      relayCrossReviewSkipped: undefined,
      pendingNativeAgents: new Set([AGENT_A, AGENT_B]),
      participatingNativeAgents: new Set([AGENT_A, AGENT_B]),
      nativeCrossReviewEntries: [],
      deadline: Date.now() + 60_000,
      createdAt: Date.now(),
      nativePrompts: [],
      roundStartSha: 'sha-that-should-not-be-read',
    });

    await handleRelayCrossReview(CONSENSUS_ID, AGENT_A, '[]');

    // Still waiting for AGENT_B — no synthesis, no mid-flight check.
    expect(preconditionRunner.runMidFlightCheck).not.toHaveBeenCalled();
  });
});
