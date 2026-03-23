import type { ConsensusReport, ConsensusFinding, ConsensusSignal, CollectResult } from '@gossip/orchestrator';

describe('Consensus types', () => {
  it('CollectResult shape is valid', () => {
    const result: CollectResult = {
      results: [],
      consensus: undefined,
    };
    expect(result.results).toEqual([]);
    expect(result.consensus).toBeUndefined();
  });

  it('ConsensusReport shape is valid', () => {
    const signal: ConsensusSignal = {
      type: 'consensus',
      taskId: 't1',
      signal: 'agreement',
      agentId: 'a1',
      evidence: 'test',
      timestamp: new Date().toISOString(),
    };
    const finding: ConsensusFinding = {
      id: 'f1',
      originalAgentId: 'a1',
      finding: 'test finding',
      tag: 'confirmed',
      confirmedBy: ['a2'],
      disputedBy: [],
      confidence: 4,
    };
    const report: ConsensusReport = {
      agentCount: 2,
      rounds: 2,
      confirmed: [finding],
      disputed: [],
      unique: [],
      newFindings: [],
      signals: [signal],
      summary: 'test summary',
    };
    expect(report.agentCount).toBe(2);
    expect(report.confirmed).toHaveLength(1);
    expect(signal.type).toBe('consensus');
  });
});
