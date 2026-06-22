import type { ConsensusRun, PeerRelationship, PeerRelationshipMap } from './types';

/**
 * Order-independent pair key: alphabetically-sorted agent ids joined with `::`.
 * peerKey('opus-implementer', 'sonnet-reviewer') === peerKey('sonnet-reviewer', 'opus-implementer').
 */
export function peerKey(a: string, b: string): string {
  return a <= b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Signal types that count as confirming the pair (trust).
 * `agreement` + `unique_confirmed` are cross-review verdicts; `impl_peer_approved`
 * is the write-mode peer code-review approval (counterpartId enforced server-side
 * at apps/cli/src/mcp-server-sdk.ts:2826 — always carries a peer relationship).
 */
const CONFIRMED_SIGNALS = new Set<string>([
  'agreement',
  'unique_confirmed',
  'impl_peer_approved',
]);
/**
 * Signal types that count as disputed (mixed).
 * `disagreement` is the cross-review counterpart; `impl_peer_rejected` is the
 * write-mode peer code-review rejection (counterpartId-bearing).
 */
const DISPUTED_SIGNALS = new Set<string>(['disagreement', 'impl_peer_rejected']);
/** Signal types that count as a hallucination catch (adversarial). */
const CATCH_SIGNALS = new Set<string>(['hallucination_caught']);

/**
 * Aggregate peer-pair relationships from a list of consensus rounds. Pure
 * function — same input always produces the same Map. Memoized at the hook
 * layer; do not memoize here.
 *
 * Skips:
 *   - retracted rounds (matches App.tsx:visibleRuns filter pattern)
 *   - signals missing counterpartId OR agentId (or empty strings)
 *   - signal types not in CONFIRMED/DISPUTED/CATCH (e.g. new_finding, insights)
 */
export function aggregatePeerRelationships(runs: ConsensusRun[]): PeerRelationshipMap {
  const map: PeerRelationshipMap = new Map();
  // Per-pair, track which taskIds we've already counted toward `rounds`.
  const seenRoundsByPair = new Map<string, Set<string>>();

  for (const round of runs) {
    if (round.retracted) continue;
    for (const sig of round.signals) {
      // Both ids required and non-empty — empty-string would produce phantom map keys.
      if (!sig.counterpartId || !sig.agentId) continue;
      const isConfirmed = CONFIRMED_SIGNALS.has(sig.signal);
      const isDisputed = DISPUTED_SIGNALS.has(sig.signal);
      const isCatch = CATCH_SIGNALS.has(sig.signal);
      if (!isConfirmed && !isDisputed && !isCatch) continue;

      const key = peerKey(sig.agentId, sig.counterpartId);
      let rel = map.get(key);
      if (!rel) {
        rel = { rounds: 0, confirmed: 0, disputed: 0, hallucinationsCaught: 0, lastInteraction: round.timestamp };
        map.set(key, rel);
      }

      if (isConfirmed) rel.confirmed += 1;
      if (isDisputed) rel.disputed += 1;
      if (isCatch) rel.hallucinationsCaught += 1;

      // Count this round once per pair (distinct taskIds).
      let seenRounds = seenRoundsByPair.get(key);
      if (!seenRounds) {
        seenRounds = new Set();
        seenRoundsByPair.set(key, seenRounds);
      }
      if (!seenRounds.has(round.taskId)) {
        seenRounds.add(round.taskId);
        rel.rounds += 1;
      }

      // lastInteraction = max timestamp across counted signals for this pair.
      if (round.timestamp > rel.lastInteraction) {
        rel.lastInteraction = round.timestamp;
      }
    }
  }

  return map;
}

export type { PeerRelationship, PeerRelationshipMap };
