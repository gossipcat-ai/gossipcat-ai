/**
 * Issue #738 — `consensus_coverage_degraded` could never fire for a timed-out arm.
 *
 * Every caller of `synthesizeWithCrossReview` pre-filters its results to
 * `status === 'completed'` before the engine sees them (collect.ts round-proceeds
 * gate + round snapshot, relay-cross-review.ts completion/timeout snapshots), and
 * the detector then computed `expected` as `results.length` — i.e. the number of
 * arms that ARRIVED. A 3-arm round where 1 arm timed out reached the engine as a
 * 2-entry array, `expected` read 2, and the round looked like full coverage.
 *
 * The fix carries the dispatched-but-lost agent ids through as
 * `options.lostAgents` so `expected` means "arms dispatched".
 */
import { ConsensusEngine, ConsensusEngineConfig } from '../../packages/orchestrator/src/consensus-engine';
import { parseCoverageDegradedMessage } from '../../packages/orchestrator/src/coverage-degraded';
import { testRound } from '../../packages/orchestrator/src/round-context';
import { TaskEntry } from '../../packages/orchestrator/src/types';
import { ILLMProvider } from '../../packages/orchestrator/src/llm-client';

describe('#738 — coverage degradation counts arms that never arrived', () => {
  const mockLlm: jest.Mocked<ILLMProvider> = { generate: jest.fn() };
  const baseConfig = (): ConsensusEngineConfig => ({
    llm: mockLlm,
    registryGet: (id: string) => ({
      id, provider: 'local' as const, model: 'test', preset: 'reviewer', skills: [] as string[],
    }),
    round: testRound(),
  });

  const completed = (agentId: string, result: string): TaskEntry => ({
    id: `task-${agentId}`, agentId, task: 'review', status: 'completed' as const,
    result, startedAt: Date.now(), completedAt: Date.now(),
    inputTokens: 100, outputTokens: 200,
  }) as TaskEntry;

  const finding = (text: string) =>
    `## Consensus Summary\n<agent_finding type="finding" severity="high">${text}</agent_finding>`;

  /** The two arms that DID return in a nominally-3-arm round. */
  const arrivedPair = (): TaskEntry[] => [
    completed('agent-a', finding('Missing token validation in auth.ts:10 allows bypass')),
    completed('agent-b', finding('Missing input validation in router.ts:22 for user query')),
  ];

  const coverageSignal = (report: { signals: Array<{ signal: string; evidence?: string; agentId?: string }> }) =>
    report.signals.find(s => s.signal === 'consensus_coverage_degraded');

  beforeEach(() => jest.clearAllMocks());

  it('fires for a 3-arm round where 1 arm timed out — the lost arm is counted as dropped', async () => {
    const engine = new ConsensusEngine(baseConfig());

    // Exactly the shape collect.ts hands over: completed-only results, plus the
    // id of the arm that was dispatched but never came back.
    const report = await engine.synthesizeWithCrossReview(
      arrivedPair(), [], 'lost0001-lost0001', undefined,
      { lostAgents: ['agent-c'] },
    );

    const signal = coverageSignal(report);
    expect(signal).toBeDefined();
    expect(signal!.agentId).toBe('_round');

    const parsed = parseCoverageDegradedMessage(signal!.evidence!);
    expect(parsed).toEqual({ received: 2, expected: 3, droppedAgents: ['agent-c'] });

    // Mirrored into the warnings channel + the human-readable summary.
    const warn = (report.warnings ?? []).filter(w => w.code === 'coverage_degraded');
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain('2/3');
    expect(report.summary).toContain('Coverage degraded: 2/3');
    expect(report.summary).toContain('agent-c');
  });

  it('does NOT fire when every dispatched arm arrived with content (no regression)', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const results = [
      ...arrivedPair(),
      completed('agent-c', finding('Unbounded retry loop in queue.ts:88 exhausts the pool')),
    ];

    const report = await engine.synthesizeWithCrossReview(results, [], 'ok000001-ok000001', undefined, { lostAgents: [] });

    expect(coverageSignal(report)).toBeUndefined();
    expect((report.warnings ?? []).some(w => w.code === 'coverage_degraded')).toBe(false);
  });

  it('preserves the pre-existing empty-content detector when no arm was lost', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const results = [...arrivedPair(), completed('agent-c', '')];

    const report = await engine.synthesizeWithCrossReview(results, [], 'empt0001-empt0001');

    const parsed = parseCoverageDegradedMessage(coverageSignal(report)!.evidence!);
    expect(parsed).toEqual({ received: 2, expected: 3, droppedAgents: ['agent-c'] });
  });

  it('counts an empty-content arrival AND a lost arm together in one 4-arm round', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const results = [...arrivedPair(), completed('agent-c', '   ')];

    const report = await engine.synthesizeWithCrossReview(
      results, [], 'both0001-both0001', undefined,
      { lostAgents: ['agent-d'] },
    );

    const parsed = parseCoverageDegradedMessage(coverageSignal(report)!.evidence!);
    expect(parsed!.received).toBe(2);
    expect(parsed!.expected).toBe(4);
    expect(parsed!.droppedAgents.sort()).toEqual(['agent-c', 'agent-d']);
  });

  it('does not inflate the denominator when a caller reports an arm that actually arrived', async () => {
    const engine = new ConsensusEngine(baseConfig());

    // Defensive: a buggy/duplicating caller lists an id that IS present in
    // `results`. It must be ignored, not double-counted.
    const report = await engine.synthesizeWithCrossReview(
      arrivedPair(), [], 'dup00001-dup00001', undefined,
      { lostAgents: ['agent-b', 'agent-c', 'agent-c'] },
    );

    const parsed = parseCoverageDegradedMessage(coverageSignal(report)!.evidence!);
    expect(parsed).toEqual({ received: 2, expected: 3, droppedAgents: ['agent-c'] });
  });

  it('behaves exactly as before when the options argument is omitted', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const report = await engine.synthesizeWithCrossReview(arrivedPair(), [], 'none0001-none0001');
    expect(coverageSignal(report)).toBeUndefined();
  });

  it('warns that finding tags reflect only the arms that returned', async () => {
    // Conservative form of issue direction 3: the tagging loop still has no
    // expected-participant denominator, so a lost arm's would-be dissent is
    // absent from every confirmed/disputed tally. Say so rather than presenting
    // the tags as full-coverage.
    const engine = new ConsensusEngine(baseConfig());
    const report = await engine.synthesizeWithCrossReview(
      arrivedPair(), [], 'tags0001-tags0001', undefined,
      { lostAgents: ['agent-c'] },
    );

    expect(report.summary).toContain('finding tags reflect only the 2 arm(s) that returned');
    expect(report.summary).toContain('agent-c');
  });

  it('omits the tag-coverage caveat when the only dropout arrived empty', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const report = await engine.synthesizeWithCrossReview(
      [...arrivedPair(), completed('agent-c', '')], [], 'noct0001-noct0001',
    );

    expect(report.summary).toContain('Coverage degraded: 2/3');
    expect(report.summary).not.toContain('finding tags reflect only');
  });
});
