/**
 * consensus-engine synthesis stamps `signal_class: 'performance'` on every
 * scoring-class signal it emits.
 *
 * Why this matters (consensus c2fb69d4-6a714a73, stacks on 7b5528b2):
 * `resolveSignalCategory` is allowed to return null — review vocabulary that
 * matches no CATEGORY_PATTERNS entry is a logged, expected condition, and the
 * signal is deliberately recorded with `category: undefined` rather than
 * dropped. Without the stamp, such a row is byte-identical to the
 * category-less `disagreement` that apps/cli/src/handlers/collect.ts writes for
 * a failed dispatch, so performance-reader's circuit breaker classified a REAL
 * verdict as operational telemetry and skipped it. The stamp is the only thing
 * that distinguishes the two.
 *
 * See performance-reader.isOperationalDisagreement and its sibling suite
 * performance-reader-operational-disagreement-breaker.test.ts.
 */

import { testRound } from '../../packages/orchestrator/src/round-context';
import { ConsensusEngine, CrossReviewEntry } from '../../packages/orchestrator/src/consensus-engine';
import { TaskEntry } from '../../packages/orchestrator/src/types';

const makeEngine = () => new ConsensusEngine({
  llm: { generate: jest.fn() } as any,
  registryGet: (id: string) => ({ id, provider: 'local', model: 'test', preset: `preset-${id}`, skills: [] }),
  round: testRound(),
} as any);

const makeTask = (agentId: string, result: string): TaskEntry => ({
  id: `task-${agentId}`,
  agentId,
  task: 'review',
  status: 'completed',
  result,
  startedAt: Date.now(),
  completedAt: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
});

/** Every signal synthesis emits for finding-evaluation outcomes. */
const SCORING_SIGNALS = new Set([
  'agreement',
  'disagreement',
  'unverified',
  'unique_confirmed',
  'unique_unconfirmed',
  'new_finding',
  'hallucination_caught',
]);

describe('ConsensusEngine.synthesize — signal_class stamping', () => {
  it("stamps every scoring-class signal with signal_class: 'performance'", async () => {
    const engine = makeEngine();

    const resultA = makeTask(
      'agent-a',
      `<agent_finding type="finding" severity="high" category="injection_vectors">SQL injection at db.ts:42</agent_finding>
<agent_finding type="finding" severity="medium" category="type_safety">Unchecked cast at parse.ts:17</agent_finding>
<agent_finding type="finding" severity="low" category="error_handling">Swallowed error at run.ts:88</agent_finding>
<agent_finding type="finding" severity="low" category="concurrency">Unawaited promise at pool.ts:12</agent_finding>`,
    );
    const resultB = makeTask(
      'agent-b',
      `<agent_finding type="finding" severity="low" category="observability">Missing log at util.ts:10</agent_finding>`,
    );

    // Exercise every cross-review action so each push site in the synthesis
    // block fires at least once. agent-a:f4 gets no entry → unique_unconfirmed.
    const crossReview: CrossReviewEntry[] = [
      {
        action: 'agree',
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        findingId: 'agent-a:f1',
        finding: 'SQL injection at db.ts:42',
        evidence: 'Confirmed — input unsanitised before query',
        confidence: 5,
      },
      {
        action: 'disagree',
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        findingId: 'agent-a:f2',
        finding: 'Unchecked cast at parse.ts:17',
        evidence: 'The cast is guarded by a typeof check on the line above',
        confidence: 4,
      },
      {
        action: 'unverified',
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        findingId: 'agent-a:f3',
        finding: 'Swallowed error at run.ts:88',
        evidence: 'Could not locate the cited line',
        confidence: 2,
      },
      {
        action: 'new',
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        finding: 'Unvalidated path join at loader.ts:31',
        evidence: 'Path segments are concatenated without a traversal check',
        confidence: 4,
      },
    ];

    const report = await engine.synthesize([resultA, resultB], crossReview);

    const scoring = report.signals.filter(s => SCORING_SIGNALS.has(s.signal));
    // Guard against a vacuous pass if synthesis stops emitting these.
    expect(scoring.length).toBeGreaterThanOrEqual(4);
    const unstamped = scoring.filter(s => s.signal_class !== 'performance');
    expect(unstamped.map(s => `${s.signal}/${s.agentId}`)).toEqual([]);
  });

  it("stamps a disagreement whose category resolution failed — the breaker's admission key", async () => {
    const engine = makeEngine();

    // Deliberately category-free vocabulary on both the finding and the
    // evidence so resolveSignalCategory returns null and the signal is
    // recorded with `category: undefined`.
    const resultA = makeTask(
      'agent-a',
      `<agent_finding type="finding" severity="medium">The wording of the summary paragraph reads oddly</agent_finding>`,
    );
    const resultB = makeTask(
      'agent-b',
      `<agent_finding type="finding" severity="low" category="observability">Missing log at util.ts:10</agent_finding>`,
    );

    const crossReview: CrossReviewEntry[] = [
      {
        action: 'disagree',
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        findingId: 'agent-a:f1',
        finding: 'The wording of the summary paragraph reads oddly',
        evidence: 'The phrasing matches the surrounding prose',
        confidence: 4,
      },
    ];

    const report = await engine.synthesize([resultA, resultB], crossReview);

    const disagreement = report.signals.find(
      s => s.signal === 'disagreement' && s.agentId === 'agent-b',
    );
    expect(disagreement).toBeDefined();
    expect(disagreement!.category).toBeUndefined();
    // Uncategorized but stamped: performance-reader must read this as a real
    // verdict, not as a collect.ts dispatch failure.
    expect(disagreement!.signal_class).toBe('performance');
  });
});
