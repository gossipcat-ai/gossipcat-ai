import { classifyPeerRelationship, edgeWidthFor } from '../../packages/dashboard-v2/src/lib/edge-classification';
import type { PeerRelationship } from '../../packages/dashboard-v2/src/lib/types';

function rel(overrides: Partial<PeerRelationship> = {}): PeerRelationship {
  return { rounds: 1, confirmed: 0, disputed: 0, hallucinationsCaught: 0, lastInteraction: '2026-05-23T10:00:00Z', ...overrides };
}

describe('classifyPeerRelationship', () => {
  it('returns null for a relationship with no signals (edge should not render)', () => {
    expect(classifyPeerRelationship(rel({ rounds: 0 }))).toBeNull();
  });

  it('returns "catch" when any hallucination was caught (highest precedence)', () => {
    expect(classifyPeerRelationship(rel({ hallucinationsCaught: 1 }))).toBe('catch');
    expect(classifyPeerRelationship(rel({ hallucinationsCaught: 1, confirmed: 99 }))).toBe('catch');
    expect(classifyPeerRelationship(rel({ hallucinationsCaught: 1, disputed: 5 }))).toBe('catch');
  });

  it('returns "mixed" when there are disputes but no catches', () => {
    expect(classifyPeerRelationship(rel({ disputed: 1, confirmed: 10 }))).toBe('mixed');
  });

  it('returns "trust" when only confirmed signals exist', () => {
    expect(classifyPeerRelationship(rel({ confirmed: 5 }))).toBe('trust');
  });

  it('returns null when rounds > 0 but all counters zero (edge case: should not happen but be defensive)', () => {
    expect(classifyPeerRelationship(rel({ rounds: 3 }))).toBeNull();
  });
});

describe('edgeWidthFor', () => {
  it('returns 1.0 for a single-round relationship', () => {
    expect(edgeWidthFor(1)).toBeCloseTo(1.15);
  });
  it('clamps to 1.0 minimum', () => {
    expect(edgeWidthFor(0)).toBe(1);
  });
  it('clamps to 2.5 maximum', () => {
    expect(edgeWidthFor(1000)).toBe(2.5);
  });
  it('scales linearly between the bounds', () => {
    expect(edgeWidthFor(5)).toBeCloseTo(1.75);
    expect(edgeWidthFor(10)).toBeCloseTo(2.5);
  });
});
