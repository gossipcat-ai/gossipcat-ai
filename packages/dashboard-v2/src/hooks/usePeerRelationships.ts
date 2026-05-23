import { useMemo } from 'react';
import { aggregatePeerRelationships } from '../lib/peer-relationships';
import type { ConsensusRun, PeerRelationshipMap } from '../lib/types';

/**
 * Memoized client-side aggregator: derives the peer-pair relationship Map
 * from the already-fetched consensus runs. Recomputes only when the `runs`
 * array reference changes (relying on the upstream `useDashboardData` hook
 * to keep stable references between polls when data is unchanged).
 *
 * Powers Phase 1b's AgentNetworkGraph edge encoding. See spec
 * `docs/superpowers/specs/2026-05-22-dashboard-redesign-phase1b-agent-network-graph-design.md`
 * §"Peer-relationship data".
 */
export function usePeerRelationships(runs: ConsensusRun[] | undefined): PeerRelationshipMap {
  return useMemo(() => aggregatePeerRelationships(runs ?? []), [runs]);
}
