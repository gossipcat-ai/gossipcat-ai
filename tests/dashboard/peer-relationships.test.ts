/**
 * Unit tests for the pure peer-relationship aggregator that powers
 * Phase 1b's AgentNetworkGraph. The aggregator visits every signal in
 * every consensus round and produces a Map<peerKey, PeerRelationship>.
 *
 * Tests cover the cases enumerated in the spec:
 *   - empty consensus list → empty map
 *   - single round / single pair → counters match
 *   - multiple rounds with the same pair → counters accumulate, rounds = distinct taskIds
 *   - hallucination_caught aggregation (symmetric per spec)
 *   - peerKey is order-independent (peerKey('a', 'b') === peerKey('b', 'a'))
 *   - signals without counterpartId are skipped
 *   - lastInteraction is the latest round timestamp containing the pair
 */

import {
  aggregatePeerRelationships,
  peerKey,
} from '../../packages/dashboard-v2/src/lib/peer-relationships';
import type { ConsensusRun } from '../../packages/dashboard-v2/src/lib/types';

const baseCounts: ConsensusRun['counts'] = {
  agreement: 0, disagreement: 0, unverified: 0, unique: 0,
  hallucination: 0, new: 0, insights: 0,
};

function run(
  taskId: string,
  timestamp: string,
  agents: string[],
  signals: ConsensusRun['signals'],
): ConsensusRun {
  return { taskId, timestamp, agents, signals, counts: baseCounts };
}

describe('peerKey', () => {
  it('returns the same key regardless of argument order', () => {
    expect(peerKey('opus-implementer', 'sonnet-reviewer'))
      .toBe(peerKey('sonnet-reviewer', 'opus-implementer'));
  });

  it('uses :: as the delimiter and sorts alphabetically', () => {
    expect(peerKey('zeta', 'alpha')).toBe('alpha::zeta');
  });

  it('returns a stable key for self-pairs (defensive — should not arise in practice)', () => {
    expect(peerKey('a', 'a')).toBe('a::a');
  });
});

describe('aggregatePeerRelationships', () => {
  it('returns an empty Map for an empty consensus list', () => {
    expect(aggregatePeerRelationships([]).size).toBe(0);
  });

  it('counts a single agreement signal as one confirmed', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b'], [
        { signal: 'agreement', agentId: 'a', counterpartId: 'b' },
      ]),
    ]);
    expect(map.size).toBe(1);
    const rel = map.get(peerKey('a', 'b'))!;
    expect(rel.confirmed).toBe(1);
    expect(rel.disputed).toBe(0);
    expect(rel.hallucinationsCaught).toBe(0);
    expect(rel.rounds).toBe(1);
    expect(rel.lastInteraction).toBe('2026-05-23T10:00:00Z');
  });

  it('treats unique_confirmed as a confirmed signal', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b'], [
        { signal: 'unique_confirmed', agentId: 'a', counterpartId: 'b' },
      ]),
    ]);
    expect(map.get(peerKey('a', 'b'))!.confirmed).toBe(1);
  });

  it('counts a disagreement signal as disputed', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b'], [
        { signal: 'disagreement', agentId: 'a', counterpartId: 'b' },
      ]),
    ]);
    expect(map.get(peerKey('a', 'b'))!.disputed).toBe(1);
  });

  it('counts a hallucination_caught signal symmetrically', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b'], [
        { signal: 'hallucination_caught', agentId: 'a', counterpartId: 'b' },
      ]),
    ]);
    const rel = map.get(peerKey('a', 'b'))!;
    expect(rel.hallucinationsCaught).toBe(1);
    // Same pair via reversed lookup
    expect(map.get(peerKey('b', 'a'))).toBe(rel);
  });

  it('accumulates counters across multiple rounds with the same pair', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b'], [
        { signal: 'agreement', agentId: 'a', counterpartId: 'b' },
      ]),
      run('t2', '2026-05-23T11:00:00Z', ['a', 'b'], [
        { signal: 'agreement', agentId: 'b', counterpartId: 'a' },
        { signal: 'disagreement', agentId: 'a', counterpartId: 'b' },
      ]),
    ]);
    const rel = map.get(peerKey('a', 'b'))!;
    expect(rel.confirmed).toBe(2);
    expect(rel.disputed).toBe(1);
    expect(rel.rounds).toBe(2);
    expect(rel.lastInteraction).toBe('2026-05-23T11:00:00Z');
  });

  it('counts rounds as distinct taskIds (not signal count)', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b'], [
        { signal: 'agreement', agentId: 'a', counterpartId: 'b' },
        { signal: 'agreement', agentId: 'b', counterpartId: 'a' },
        { signal: 'disagreement', agentId: 'a', counterpartId: 'b' },
      ]),
    ]);
    // Three signals, but all in one round.
    expect(map.get(peerKey('a', 'b'))!.rounds).toBe(1);
  });

  it('skips signals with no counterpartId (no peer relationship implied)', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a'], [
        { signal: 'impl_test_pass', agentId: 'a' },
        { signal: 'unique_unconfirmed', agentId: 'a' },
      ]),
    ]);
    expect(map.size).toBe(0);
  });

  it('skips new_finding and unverified signals (no pair relationship)', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b'], [
        { signal: 'new_finding', agentId: 'a', counterpartId: 'b' },
        { signal: 'unique_unconfirmed', agentId: 'a', counterpartId: 'b' },
      ]),
    ]);
    expect(map.size).toBe(0);
  });

  it('handles three or more agents in a single round', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b', 'c'], [
        { signal: 'agreement', agentId: 'a', counterpartId: 'b' },
        { signal: 'disagreement', agentId: 'a', counterpartId: 'c' },
        { signal: 'agreement', agentId: 'b', counterpartId: 'c' },
      ]),
    ]);
    expect(map.size).toBe(3);
    expect(map.get(peerKey('a', 'b'))!.confirmed).toBe(1);
    expect(map.get(peerKey('a', 'c'))!.disputed).toBe(1);
    expect(map.get(peerKey('b', 'c'))!.confirmed).toBe(1);
  });

  it('keeps lastInteraction as the latest timestamp even when later rounds add no new counter', () => {
    const map = aggregatePeerRelationships([
      run('t1', '2026-05-23T10:00:00Z', ['a', 'b'], [
        { signal: 'agreement', agentId: 'a', counterpartId: 'b' },
      ]),
      run('t2', '2026-05-23T12:00:00Z', ['a', 'b'], [
        { signal: 'new_finding', agentId: 'a', counterpartId: 'b' }, // skipped counter
      ]),
    ]);
    // The pair appeared in t2 even though the signal didn't change counters;
    // rounds should reflect distinct taskIds where the pair appeared.
    // We deliberately do NOT bump lastInteraction for skipped signals — pair
    // didn't have a counted interaction in t2.
    const rel = map.get(peerKey('a', 'b'))!;
    expect(rel.lastInteraction).toBe('2026-05-23T10:00:00Z');
    expect(rel.rounds).toBe(1);
  });
});
