import { useMemo } from 'react';
import { aggregatePeerRelationships } from '../lib/peer-relationships';
import type { ConsensusRun, PeerRelationshipMap } from '../lib/types';

/**
 * Memoized client-side aggregator: derives the peer-pair relationship Map
 * from the already-fetched consensus runs. Recomputes on every render where
 * the `runs` array reference changes.
 *
 * NOTE on memo effectiveness: `useDashboardData` produces a fresh `runs`
 * reference on every 5s poll (JSON.parse → new array), so this memo rarely
 * hits in practice. The aggregator is O(N × signals_per_round) — at the
 * current pageSize=500 cap that's ≤16ms per recompute, well within frame
 * budget. If the perf surfaces in Phase 1b PRs 3-6, add a structural-equality
 * stabilizer (hash of `lastConsensusTimestamp + totalSignals`) in
 * `useDashboardData` rather than complicating this hook.
 *
 * Powers Phase 1b's AgentNetworkGraph edge encoding. See spec
 * `docs/superpowers/specs/2026-05-22-dashboard-redesign-phase1b-agent-network-graph-design.md`
 * §"Peer-relationship data".
 */
export function usePeerRelationships(runs: ConsensusRun[] | undefined): PeerRelationshipMap {
  return useMemo(() => aggregatePeerRelationships(runs ?? []), [runs]);
}
