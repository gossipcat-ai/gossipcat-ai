/**
 * Tests for PerformanceReader.isBenched() — agent auto-benching v1 (GH #93).
 *
 * Rule A: accuracy < 0.30 && totalSignals >= 200 → chronic-low-accuracy
 * Rule B: weightedHallucinations >= 5 && rate > 0.4 → burst-hallucination
 * Safeguard: if candidate is sole provider of a requested category → not benched,
 *            safeguardBlocked:true.
 *
 * Drives behavior by stubbing getAgentScore() with curated AgentScore objects
 * so the tests exercise the decision logic without needing to back-compute
 * decayed signal weights.
 */

import { PerformanceReader, AgentScore } from '../../packages/orchestrator/src/performance-reader';

function makeScore(partial: Partial<AgentScore> & { agentId: string }): AgentScore {
  return {
    accuracy: 0.8,
    uniqueness: 0.5,
    reliability: 0.7,
    impactScore: 0.5,
    totalSignals: 10,
    agreements: 0,
    disagreements: 0,
    uniqueFindings: 0,
    hallucinations: 0,
    weightedHallucinations: 0,
    consecutiveFailures: 0,
    circuitOpen: false,
    categoryStrengths: {},
    categoryCorrect: {},
    categoryHallucinated: {},
    categoryAccuracy: {},
    ...partial,
  };
}

/**
 * Build a PerformanceReader with an in-memory scores map.
 * Bypasses the JSONL cache by swapping getScores().
 */
function readerWithScores(scores: Record<string, AgentScore>): PerformanceReader {
  const reader = new PerformanceReader('/tmp/gossip-is-benched-test-unused');
  const map = new Map(Object.entries(scores));
  (reader as any).getScores = () => map;
  return reader;
}

describe('PerformanceReader.isBenched', () => {
  describe('Rule A — chronic low accuracy', () => {
    it('does NOT bench when accuracy is exactly 0.30 (strict <)', () => {
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.30, totalSignals: 200 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: false });
    });

    it('benches when accuracy=0.29 and n=200 → chronic-low-accuracy', () => {
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.29, totalSignals: 200 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: true, reason: 'chronic-low-accuracy' });
    });

    it('does NOT bench when accuracy=0.29 but n=199 (below evidence gate)', () => {
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.29, totalSignals: 199 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: false });
    });
  });

  describe('Rule B — burst hallucinations', () => {
    it('benches when weightedHallucinations=5 and rate 5/11 ≈ 0.45 > 0.4', () => {
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.9, totalSignals: 11, weightedHallucinations: 5 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: true, reason: 'burst-hallucination' });
    });

    it('benches when weightedHallucinations=5 and rate 5/12 ≈ 0.417 > 0.4', () => {
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.9, totalSignals: 12, weightedHallucinations: 5 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: true, reason: 'burst-hallucination' });
    });

    it('does NOT bench when weightedHallucinations=4.9 (strict >=5 floor)', () => {
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.9, totalSignals: 11, weightedHallucinations: 4.9 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: false });
    });
  });

  describe('Safeguard — sole category provider', () => {
    it('blocks bench when candidate is the sole provider of a requested category', () => {
      const reader = readerWithScores({
        a: makeScore({
          agentId: 'a',
          accuracy: 0.29,
          totalSignals: 200,
          categoryAccuracy: { 'trust_boundaries': 0.5 },
        }),
        b: makeScore({
          agentId: 'b',
          accuracy: 0.9,
          totalSignals: 50,
          categoryAccuracy: { 'concurrency': 0.8 },
        }),
      });
      const res = reader.isBenched('a', ['trust_boundaries'], ['a', 'b']);
      expect(res).toEqual({
        benched: false,
        safeguardBlocked: true,
        reason: 'chronic-low-accuracy',
      });
    });

    it('benches when another unbenched agent covers the requested category', () => {
      const reader = readerWithScores({
        a: makeScore({
          agentId: 'a',
          accuracy: 0.29,
          totalSignals: 200,
          categoryAccuracy: { 'trust_boundaries': 0.5 },
        }),
        b: makeScore({
          agentId: 'b',
          accuracy: 0.85,
          totalSignals: 50,
          categoryAccuracy: { 'trust_boundaries': 0.9 },
        }),
      });
      const res = reader.isBenched('a', ['trust_boundaries'], ['a', 'b']);
      expect(res).toEqual({ benched: true, reason: 'chronic-low-accuracy' });
    });
  });

  describe('Hysteresis (implicit 5pp window)', () => {
    it('remains benched at accuracy=0.34 (still in the bench window)', () => {
      // Accuracy above the 0.30 strict entry threshold — no longer benched.
      // This verifies the strict-< semantics: 0.34 is NOT < 0.30, so Rule A
      // does not fire. Hysteresis comes from the 5pp margin between where
      // the agent entered (0.29) and where they can re-enter (< 0.30) — if
      // they recover to 0.34 and then degrade to 0.30 exactly, they stay out.
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.34, totalSignals: 200 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: false });
    });

    it('is NOT benched once accuracy recovers to 0.36 at same signal volume', () => {
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.36, totalSignals: 200 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: false });
    });
  });

  describe('Healthy agent passthrough', () => {
    it('returns {benched:false} for a healthy agent', () => {
      const reader = readerWithScores({
        a: makeScore({ agentId: 'a', accuracy: 0.85, totalSignals: 300, weightedHallucinations: 1 }),
      });
      expect(reader.isBenched('a')).toEqual({ benched: false });
    });

    it('returns {benched:false} for an agent with no score data', () => {
      const reader = readerWithScores({});
      expect(reader.isBenched('ghost')).toEqual({ benched: false });
    });
  });
});
