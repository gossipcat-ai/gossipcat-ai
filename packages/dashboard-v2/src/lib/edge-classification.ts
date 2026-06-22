import type { PeerRelationship } from './types';

/** Edge visual class derived from a peer relationship. `null` means no edge. */
export type EdgeClass = 'trust' | 'mixed' | 'catch';

/**
 * Classify a peer pair into an edge class. Precedence:
 *   1. Any hallucination caught → 'catch' (adversarial, red dashed)
 *   2. Any dispute → 'mixed' (amber, micro-dash)
 *   3. Any confirmed → 'trust' (green, solid)
 *   4. Otherwise null (no edge)
 *
 * See spec §"EdgeLayer — encoding".
 */
export function classifyPeerRelationship(rel: PeerRelationship): EdgeClass | null {
  if (rel.hallucinationsCaught > 0) return 'catch';
  if (rel.disputed > 0) return 'mixed';
  if (rel.confirmed > 0) return 'trust';
  return null;
}

/**
 * Stroke width in pixels, scaled by round count. Clamped to [1, 2.5].
 * Heavier weight = more interactions = more important pair.
 */
export function edgeWidthFor(rounds: number): number {
  return Math.max(1, Math.min(2.5, 1 + rounds * 0.15));
}
