import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import type { ConsensusSignal } from '../../packages/orchestrator/src/consensus-types';

function makeSignal(over: Partial<ConsensusSignal>): ConsensusSignal {
  return {
    type: 'consensus',
    taskId: 't1',
    consensusId: 'c1',
    signal: 'agreement',
    agentId: 'agent-x',
    timestamp: new Date().toISOString(),
    ...over,
  } as ConsensusSignal;
}

describe('PerformanceReader — per-category accuracy', () => {
  // Sample sizes here are ≥ MIN_CATEGORY_N (5) so that categoryAccuracy is
  // populated — below the gate, per-category accuracy is intentionally left
  // undefined to avoid skew on sparse data (see performance-reader.ts).

  it('counts agreement signals as categoryCorrect', () => {
    const reader = new PerformanceReader('');
    const signals = [
      makeSignal({ signal: 'agreement', category: 'injection_vectors', taskId: 't1' }),
      makeSignal({ signal: 'agreement', category: 'injection_vectors', taskId: 't2' }),
      makeSignal({ signal: 'agreement', category: 'injection_vectors', taskId: 't3' }),
      makeSignal({ signal: 'agreement', category: 'injection_vectors', taskId: 't4' }),
      makeSignal({ signal: 'agreement', category: 'injection_vectors', taskId: 't5' }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('agent-x');
    expect(score.categoryCorrect.injection_vectors).toBe(5);
    expect(score.categoryHallucinated.injection_vectors ?? 0).toBe(0);
    expect(score.categoryAccuracy.injection_vectors).toBe(1.0);
  });

  it('counts hallucination_caught and disagreement as categoryHallucinated', () => {
    const reader = new PerformanceReader('');
    const signals = [
      makeSignal({ signal: 'agreement', category: 'concurrency', taskId: 't1' }),
      makeSignal({ signal: 'agreement', category: 'concurrency', taskId: 't2' }),
      makeSignal({ signal: 'hallucination_caught', category: 'concurrency', taskId: 't3' }),
      makeSignal({ signal: 'hallucination_caught', category: 'concurrency', taskId: 't4' }),
      makeSignal({ signal: 'disagreement', category: 'concurrency', taskId: 't5' }),
      makeSignal({ signal: 'disagreement', category: 'concurrency', taskId: 't6' }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('agent-x');
    expect(score.categoryCorrect.concurrency).toBe(2);
    expect(score.categoryHallucinated.concurrency).toBe(4);
    expect(score.categoryAccuracy.concurrency).toBeCloseTo(2 / 6, 4);
  });

  it('excludes signals without a category from per-category counters', () => {
    const reader = new PerformanceReader('');
    const signals = [
      makeSignal({ signal: 'agreement', category: undefined, taskId: 't1' }),
      makeSignal({ signal: 'hallucination_caught', category: undefined, taskId: 't2' }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('agent-x');
    expect(Object.keys(score.categoryCorrect)).toHaveLength(0);
    expect(Object.keys(score.categoryHallucinated)).toHaveLength(0);
  });

  it('Test 3 — excludes retracted signals from per-category counters', () => {
    const reader = new PerformanceReader('');
    const signals = [
      makeSignal({ signal: 'agreement', category: 'concurrency', taskId: 't1' }),
      makeSignal({ signal: 'agreement', category: 'concurrency', taskId: 't2' }),
      makeSignal({ signal: 'agreement', category: 'concurrency', taskId: 't3' }),
      makeSignal({ signal: 'agreement', category: 'concurrency', taskId: 't4' }),
      makeSignal({ signal: 'agreement', category: 'concurrency', taskId: 't5' }),
      makeSignal({ signal: 'signal_retracted', category: 'concurrency', taskId: 't1' }), // retracts t1
      makeSignal({ signal: 'hallucination_caught', category: 'concurrency', taskId: 't6' }),
      makeSignal({ signal: 'hallucination_caught', category: 'concurrency', taskId: 't7' }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('agent-x');
    // After retraction of t1: 4 correct (t2..t5), 2 hallucinated (t6, t7). Total 6 ≥ MIN_CATEGORY_N.
    expect(score.categoryCorrect.concurrency).toBe(4);
    expect(score.categoryHallucinated.concurrency).toBe(2);
    expect(score.categoryAccuracy.concurrency).toBeCloseTo(4 / 6, 4);
  });
});
