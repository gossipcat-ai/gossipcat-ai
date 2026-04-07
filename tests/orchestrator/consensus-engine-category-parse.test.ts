import { describe, it, expect, vi } from 'vitest';
import { ConsensusEngine, CrossReviewEntry } from '../../packages/orchestrator/src/consensus-engine';
import { TaskEntry } from '../../packages/orchestrator/src/types';

// Minimal engine config so formatReport's registryGet call doesn't throw
const makeEngine = () => new ConsensusEngine({
  llm: { generate: vi.fn() } as any,
  registryGet: (id: string) => ({ id, provider: 'local', model: 'test', preset: `preset-${id}`, skills: [] }),
} as any);

// Minimal stub: synthesize() only needs status/result/id/agentId from TaskEntry
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

describe('ConsensusEngine — category attribute parsing', () => {
  it('extracts category from <agent_finding> tag attribute', () => {
    const engine = new ConsensusEngine({} as any);
    const raw = `## Consensus Summary
<agent_finding type="finding" severity="high" category="injection_vectors">
SQL injection at db.ts:42
</agent_finding>`;
    const findings = (engine as any).parseAgentFindings('agent-x', raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('injection_vectors');
  });

  it('returns undefined category when attribute is absent', () => {
    const engine = new ConsensusEngine({} as any);
    const raw = `<agent_finding type="finding" severity="high">No category here at all</agent_finding>`;
    const findings = (engine as any).parseAgentFindings('agent-x', raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBeUndefined();
  });

  describe('synthesize() — category propagation onto signals', () => {
    it('propagates category onto agreement signal', async () => {
      const engine = makeEngine();

      // Agent A emits a categorised finding
      const resultA = makeTask('agent-a', `<agent_finding type="finding" severity="high" category="injection_vectors">SQL injection at db.ts:42</agent_finding>`);
      // Agent B is a peer (needs a finding too so synthesize counts it as successful)
      const resultB = makeTask('agent-b', `<agent_finding type="finding" severity="low">Unrelated finding at util.ts:10</agent_finding>`);

      // Agent B agrees with agent-a:f1
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
      ];

      const report = await engine.synthesize([resultA, resultB], crossReview);

      const agreementSignal = report.signals.find(
        s => s.signal === 'agreement' && s.agentId === 'agent-b',
      );
      expect(agreementSignal, 'agreement signal must exist').toBeDefined();
      expect(agreementSignal!.category).toBe('injection_vectors');
    });

    it('propagates category onto hallucination_caught signal (disagree path)', async () => {
      const engine = makeEngine();

      const resultA = makeTask('agent-a', `<agent_finding type="finding" severity="high" category="injection_vectors">SQL injection at db.ts:42</agent_finding>`);
      const resultB = makeTask('agent-b', `<agent_finding type="finding" severity="low">Unrelated finding at util.ts:10</agent_finding>`);

      // Agent B disagrees with a hallucination keyword + fabricated citation trigger
      // Use keywords known to trigger detectHallucination (e.g. "does not exist")
      const crossReview: CrossReviewEntry[] = [
        {
          action: 'disagree',
          agentId: 'agent-b',
          peerAgentId: 'agent-a',
          findingId: 'agent-a:f1',
          finding: 'SQL injection at db.ts:42',
          evidence: 'this function does not exist anywhere in the codebase, I cannot find it',
          confidence: 1,
        },
      ];

      const report = await engine.synthesize([resultA, resultB], crossReview);

      // Either hallucination_caught or disagreement will be emitted — both must carry category
      const relatedSignal = report.signals.find(
        s => (s.signal === 'hallucination_caught' || s.signal === 'disagreement') && s.agentId === 'agent-b',
      );
      expect(relatedSignal, 'disagreement or hallucination_caught signal must exist').toBeDefined();
      expect(relatedSignal!.category).toBe('injection_vectors');
    });

    it('propagates category onto unique_confirmed signal', async () => {
      const engine = makeEngine();

      const resultA = makeTask('agent-a', `<agent_finding type="finding" severity="critical" category="injection_vectors">SQL injection at db.ts:42</agent_finding>`);
      const resultB = makeTask('agent-b', `<agent_finding type="finding" severity="low">Unrelated finding at util.ts:10</agent_finding>`);

      // Agent B agrees — makes it confirmed; unique because only agent-a found it
      const crossReview: CrossReviewEntry[] = [
        {
          action: 'agree',
          agentId: 'agent-b',
          peerAgentId: 'agent-a',
          findingId: 'agent-a:f1',
          finding: 'SQL injection at db.ts:42',
          evidence: 'Confirmed',
          confidence: 5,
        },
      ];

      const report = await engine.synthesize([resultA, resultB], crossReview);

      const uniqueConfirmed = report.signals.find(
        s => s.signal === 'unique_confirmed' && s.agentId === 'agent-a',
      );
      expect(uniqueConfirmed, 'unique_confirmed signal must exist').toBeDefined();
      expect(uniqueConfirmed!.category).toBe('injection_vectors');
    });
  });

  describe('deduplicateFindings — category merge', () => {
    it('surviving entry inherits category from loser when survivor has none (A-wins branch)', () => {
      const engine = new ConsensusEngine({} as any);

      // entryA: no category (will survive as A-wins default branch)
      // entryB: has category "injection_vectors" (will be merged into A)
      // Both reference the same file and have high Jaccard overlap to trigger dedup.
      const findingMap = new Map<string, any>([
        ['agent-a:f1', {
          originalAgentId: 'agent-a',
          finding: 'SQL injection vulnerability in db.ts allows unsanitised input directly into query builder',
          findingType: 'finding',
          severity: 'high',
          category: undefined,
          confirmedBy: [],
          disputedBy: [],
          unverifiedBy: [],
          confidences: [4],
        }],
        ['agent-b:f1', {
          originalAgentId: 'agent-b',
          finding: 'SQL injection vulnerability in db.ts allows unsanitised input directly into query builder',
          findingType: 'finding',
          severity: 'high',
          category: 'injection_vectors',
          confirmedBy: [],
          disputedBy: [],
          unverifiedBy: [],
          confidences: [4],
        }],
      ]);

      (engine as any).deduplicateFindings(findingMap);

      // After dedup, only one entry should remain
      expect(findingMap.size).toBe(1);

      const surviving = Array.from(findingMap.values())[0];
      expect(surviving.category).toBe('injection_vectors');
    });

    it('surviving entry inherits category from loser when survivor has none (B-wins branch)', () => {
      const engine = new ConsensusEngine({} as any);

      // entryA: HAS category "injection_vectors", but NO line citation (so B wins — B has :42 citation)
      // entryB: no category but has a line citation (B-wins branch, B survives without category)
      // Bug: B wins but B has no category, even though A (the loser) had one.
      const findingMap = new Map<string, any>([
        ['agent-a:f1', {
          originalAgentId: 'agent-a',
          finding: 'SQL injection vulnerability in db.ts allows unsanitised input directly into query builder',
          findingType: 'finding',
          severity: 'high',
          category: 'injection_vectors',
          confirmedBy: [],
          disputedBy: [],
          unverifiedBy: [],
          confidences: [4],
        }],
        ['agent-b:f1', {
          originalAgentId: 'agent-b',
          finding: 'SQL injection vulnerability in db.ts:42 allows unsanitised input directly into query builder',
          findingType: 'finding',
          severity: 'high',
          category: undefined,
          confirmedBy: [],
          disputedBy: [],
          unverifiedBy: [],
          confidences: [4],
        }],
      ]);

      (engine as any).deduplicateFindings(findingMap);

      expect(findingMap.size).toBe(1);
      const surviving = Array.from(findingMap.values())[0];
      expect(surviving.category).toBe('injection_vectors');
    });
  });
});
