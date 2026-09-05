/**
 * Issue #746 — `consensus_coverage_degraded` never fired on the server-side
 * Phase-2 path (all-relay rounds).
 *
 * `handleCollect` routes to `engine.runSelectedCrossReview` whenever
 * `engine.hasPerformanceReader && !hasNative` (apps/cli/src/handlers/collect.ts).
 * `performanceReader` is supplied unconditionally, so that branch is taken for
 * every all-relay round. All of `runSelectedCrossReview`'s synthesis exits called
 * `synthesize()`, and the coverage detector added by #738 lived exclusively inside
 * `synthesizeWithCrossReview()` — so a timed-out arm in an all-relay round was
 * invisible to the detector. Same failure class as #738, different call path.
 *
 * The fix extracts the detector into a shared `surfaceCoverageDegraded` helper
 * invoked by BOTH paths, and gives `runSelectedCrossReview` the same
 * `options.lostAgents` contract `synthesizeWithCrossReview` already had.
 *
 * Assertions mirror tests/orchestrator/consensus-coverage-lost-arms.test.ts
 * (the native path) so both paths are held to one shape.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConsensusEngine, ConsensusEngineConfig } from '../../packages/orchestrator/src/consensus-engine';
import { parseCoverageDegradedMessage } from '../../packages/orchestrator/src/coverage-degraded';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { testRound } from '../../packages/orchestrator/src/round-context';
import { TaskEntry } from '../../packages/orchestrator/src/types';
import { ILLMProvider } from '../../packages/orchestrator/src/llm-client';

describe('#746 — server-side Phase 2 counts arms that never arrived', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lost-arm-selected-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    // Empty performance file — fresh pool, same as the selected-review suite.
    writeFileSync(join(root, '.gossip', 'agent-performance.jsonl'), '');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Cross-review returns no entries; synthesis still runs. */
  const makeLlm = (): ILLMProvider => ({
    generate: jest.fn().mockResolvedValue({
      text: '[]', inputTokens: 10, outputTokens: 10, toolCalls: [],
    }),
  }) as unknown as ILLMProvider;

  const baseConfig = (): ConsensusEngineConfig => ({
    llm: makeLlm(),
    registryGet: (id: string) => ({
      id, provider: 'local' as const, model: 'test', preset: 'reviewer', skills: [] as string[],
    }),
    projectRoot: root,
    // The exact precondition for the server-side branch in collect.ts.
    performanceReader: new PerformanceReader(root),
    round: testRound(),
  });

  const completed = (agentId: string, result: string): TaskEntry => ({
    id: `task-${agentId}`, agentId, task: 'review', status: 'completed' as const,
    result, startedAt: Date.now(), completedAt: Date.now(),
    inputTokens: 100, outputTokens: 200,
  }) as TaskEntry;

  const finding = (text: string) =>
    `## Consensus Summary\n<agent_finding type="finding" severity="high">${text}</agent_finding>`;

  /** The two relay arms that DID return in a nominally-3-arm all-relay round. */
  const arrivedPair = (): TaskEntry[] => [
    completed('relay-a', finding('Missing token validation in auth.ts:10 allows bypass')),
    completed('relay-b', finding('Missing input validation in router.ts:22 for user query')),
  ];

  const coverageSignal = (
    report: { signals: Array<{ signal: string; evidence?: string; agentId?: string; consensusId?: string }> },
  ) => report.signals.find(s => s.signal === 'consensus_coverage_degraded');

  it('fires for a 3-arm all-relay round where 1 relay arm timed out', async () => {
    const engine = new ConsensusEngine(baseConfig());
    expect(engine.hasPerformanceReader).toBe(true); // collect.ts routing precondition

    // Exactly the shape collect.ts hands over on the server-side path:
    // completed-only results, plus the id of the arm that never came back.
    const report = await engine.runSelectedCrossReview(
      arrivedPair(), 'lost0746-lost0746', { lostAgents: ['relay-c'] },
    );

    const signal = coverageSignal(report);
    expect(signal).toBeDefined();
    expect(signal!.agentId).toBe('_round');
    expect(signal!.consensusId).toBe('lost0746-lost0746');

    expect(parseCoverageDegradedMessage(signal!.evidence!)).toEqual({
      received: 2, expected: 3, droppedAgents: ['relay-c'],
    });

    // Mirrored into the warnings channel + the human-readable summary.
    const warn = (report.warnings ?? []).filter(w => w.code === 'coverage_degraded');
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain('2/3');
    expect(report.summary).toContain('Coverage degraded: 2/3');
    expect(report.summary).toContain('relay-c');
    expect(report.summary).toContain('finding tags reflect only the 2 arm(s) that returned');
  });

  it('fires on the no-structured-findings synthesis exit too', async () => {
    const engine = new ConsensusEngine(baseConfig());

    // No <agent_finding> tags → runSelectedCrossReview short-circuits to
    // synthesize() before any reviewer selection. That exit must degrade too.
    const report = await engine.runSelectedCrossReview(
      [
        completed('relay-a', 'Plain prose with no structured findings at all.'),
        completed('relay-b', 'More prose, still no finding tags anywhere.'),
      ],
      'nofi0746-nofi0746',
      { lostAgents: ['relay-c'] },
    );

    expect(parseCoverageDegradedMessage(coverageSignal(report)!.evidence!)).toEqual({
      received: 2, expected: 3, droppedAgents: ['relay-c'],
    });
  });

  it('does NOT fire when every dispatched relay arm arrived with content', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const report = await engine.runSelectedCrossReview(
      [...arrivedPair(), completed('relay-c', finding('Unbounded retry loop in queue.ts:88 exhausts the pool'))],
      'ok460000-ok460000',
      { lostAgents: [] },
    );

    expect(coverageSignal(report)).toBeUndefined();
    expect((report.warnings ?? []).some(w => w.code === 'coverage_degraded')).toBe(false);
  });

  it('behaves exactly as before when the options argument is omitted', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const report = await engine.runSelectedCrossReview(arrivedPair(), 'none0746-none0746');
    expect(coverageSignal(report)).toBeUndefined();
  });

  it('does not inflate the denominator when a caller reports an arm that actually arrived', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const report = await engine.runSelectedCrossReview(
      arrivedPair(), 'dup40746-dup40746',
      { lostAgents: ['relay-b', 'relay-c', 'relay-c'] },
    );

    expect(parseCoverageDegradedMessage(coverageSignal(report)!.evidence!)).toEqual({
      received: 2, expected: 3, droppedAgents: ['relay-c'],
    });
  });

  it('counts an empty-content arrival AND a lost arm together', async () => {
    const engine = new ConsensusEngine(baseConfig());
    const report = await engine.runSelectedCrossReview(
      [...arrivedPair(), completed('relay-c', '   ')],
      'both0746-both0746',
      { lostAgents: ['relay-d'] },
    );

    const parsed = parseCoverageDegradedMessage(coverageSignal(report)!.evidence!);
    expect(parsed!.received).toBe(2);
    expect(parsed!.expected).toBe(4);
    expect(parsed!.droppedAgents.sort()).toEqual(['relay-c', 'relay-d']);
  });
});
