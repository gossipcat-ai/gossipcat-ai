import { useMemo, useRef } from 'react';
import type { ConsensusReport } from '@/lib/types';

export interface SeverityCount {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export type SeverityCountMap = Map<string, SeverityCount>;

/**
 * Stable structural fingerprint of a SeverityCountMap — same content
 * always hashes to the same string regardless of insertion order.
 */
function fingerprint(map: SeverityCountMap): string {
  const parts: string[] = [];
  for (const [k, v] of map.entries()) {
    parts.push(`${k}:${v.critical}:${v.high}:${v.medium}:${v.low}`);
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Client-side severity count aggregator with structural stability — the
 * returned Map reference only changes when the content changes.
 *
 * Mirrors the usePeerRelationships memoization pattern: useDashboardData
 * produces a fresh array reference on every 5s poll so a plain useMemo
 * would re-derive on every tick even when no finding has changed.
 *
 * Walks all finding buckets (confirmed, disputed, unique, unverified) and
 * attributes each finding to its originalAgentId × severity. Severity
 * defaults to 'low' for findings with no severity field.
 */
export function useSeverityCounts(reports: ConsensusReport[] | null | undefined): SeverityCountMap {
  const lastFingerprint = useRef<string>('');
  const lastMap = useRef<SeverityCountMap>(new Map());

  return useMemo(() => {
    const next: SeverityCountMap = new Map();

    if (reports) {
      for (const report of reports) {
        const buckets = [
          ...(report.confirmed ?? []),
          ...(report.disputed ?? []),
          ...(report.unique ?? []),
          ...(report.unverified ?? []),
        ];
        for (const finding of buckets) {
          const agentId = finding.originalAgentId;
          if (!agentId) continue;
          const current = next.get(agentId) ?? { critical: 0, high: 0, medium: 0, low: 0 };
          const sev = finding.severity ?? 'low';
          if (sev === 'critical') current.critical += 1;
          else if (sev === 'high') current.high += 1;
          else if (sev === 'medium') current.medium += 1;
          else current.low += 1;
          next.set(agentId, current);
        }
      }
    }

    const fp = fingerprint(next);
    if (fp === lastFingerprint.current) return lastMap.current;
    lastFingerprint.current = fp;
    lastMap.current = next;
    return next;
  }, [reports]);
}
