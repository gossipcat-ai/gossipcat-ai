import { describe, it, expect } from 'vitest';
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
  it('counts agreement signals as categoryCorrect', () => {
    const reader = new PerformanceReader('');
    const signals = [
      makeSignal({ signal: 'agreement', category: 'injection_vectors', taskId: 't1' }),
      makeSignal({ signal: 'agreement', category: 'injection_vectors', taskId: 't2' }),
      makeSignal({ signal: 'agreement', category: 'injection_vectors', taskId: 't3' }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('agent-x');
    expect(score.categoryCorrect.injection_vectors).toBe(3);
    expect(score.categoryHallucinated.injection_vectors ?? 0).toBe(0);
    expect(score.categoryAccuracy.injection_vectors).toBe(1.0);
  });

  it('counts hallucination_caught and disagreement as categoryHallucinated', () => {
    const reader = new PerformanceReader('');
    const signals = [
      makeSignal({ signal: 'agreement', category: 'concurrency', taskId: 't1' }),
      makeSignal({ signal: 'hallucination_caught', category: 'concurrency', taskId: 't2' }),
      makeSignal({ signal: 'disagreement', category: 'concurrency', taskId: 't3' }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('agent-x');
    expect(score.categoryCorrect.concurrency).toBe(1);
    expect(score.categoryHallucinated.concurrency).toBe(2);
    expect(score.categoryAccuracy.concurrency).toBeCloseTo(1 / 3, 4);
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
      makeSignal({ signal: 'signal_retracted', category: 'concurrency', taskId: 't1' }), // retracts t1
      makeSignal({ signal: 'hallucination_caught', category: 'concurrency', taskId: 't4' }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('agent-x');
    // After retraction of t1: 2 correct (t2, t3), 1 hallucinated (t4)
    expect(score.categoryCorrect.concurrency).toBe(2);
    expect(score.categoryHallucinated.concurrency).toBe(1);
    expect(score.categoryAccuracy.concurrency).toBeCloseTo(2 / 3, 4);
  });
});
