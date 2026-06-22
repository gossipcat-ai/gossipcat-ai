import { useMemo, useRef } from 'react';
import { aggregatePeerRelationships } from '../lib/peer-relationships';
import type { ConsensusRun, PeerRelationshipMap } from '../lib/types';

/**
 * Stable structural fingerprint of a PeerRelationshipMap — same content
 * always hashes to the same string regardless of insertion order.
 */
function fingerprint(map: PeerRelationshipMap): string {
  const parts: string[] = [];
  for (const [k, v] of map.entries()) {
    parts.push(`${k}:${v.rounds}:${v.confirmed}:${v.disputed}:${v.hallucinationsCaught}`);
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Memoized client-side aggregator with *structural* stability: the returned
 * Map reference only changes when aggregated content actually changes.
 *
 * Why: `useDashboardData` produces a fresh `runs` array reference on every
 * 5s poll (JSON.parse → new array). Without the fingerprint cache, every
 * poll yielded a new map reference even when no peer-relationship fact had
 * changed — AgentNetworkGraph's force-simulation useEffect would tear down
 * and rebuild on every poll, visible as nodes "jumping" every 5 seconds.
 *
 * Powers Phase 1b's AgentNetworkGraph edge encoding. See spec
 * `docs/superpowers/specs/2026-05-22-dashboard-redesign-phase1b-agent-network-graph-design.md`
 * §"Peer-relationship data".
 */
export function usePeerRelationships(runs: ConsensusRun[] | undefined): PeerRelationshipMap {
  const lastFingerprint = useRef<string>('');
  const lastMap = useRef<PeerRelationshipMap>(new Map());
  return useMemo(() => {
    const next = aggregatePeerRelationships(runs ?? []);
    const fp = fingerprint(next);
    if (fp === lastFingerprint.current) return lastMap.current;
    lastFingerprint.current = fp;
    lastMap.current = next;
    return next;
  }, [runs]);
}
