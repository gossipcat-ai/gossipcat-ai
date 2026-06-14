/**
 * ActivitySparkline — compact fleet-trend sparkline for SessionRail.
 *
 * Fetches GET /dashboard/api/fleet-trend?days=7 once on mount.
 * Aggregates all agents' signals per day into a single fleet-level series,
 * then renders AreaSparkline (reused from AgentCardBig).
 *
 * Graceful: on fetch fail / empty / <2 points → renders a "—" placeholder.
 * No --accent; uses the chart token --c1 (teal) which AreaSparkline defaults to.
 *
 * DESIGN.md: no new colors, no shadow, neutral chrome.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { FleetTrendPoint, FleetTrendResponse } from '@/lib/types';
import { AreaSparkline } from '@/components/AreaSparkline';

/** Aggregate per-agent daily points into a single fleet-level signal series. */
function aggregateToFleet(points: FleetTrendPoint[]): FleetTrendPoint[] {
  const byDay = new Map<string, number>();
  for (const p of points) {
    byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.signals);
  }
  // Sort ascending by day string (ISO date sorts lexicographically).
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, signals]) => ({ day, agentId: '_fleet', accuracy: 0, signals }));
}

export function ActivitySparkline() {
  const [fleetPoints, setFleetPoints] = useState<FleetTrendPoint[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<FleetTrendResponse>('fleet-trend?days=7')
      .then((data) => {
        if (controller.signal.aborted) return;
        setFleetPoints(aggregateToFleet(data.points));
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // Silenced — graceful degradation to placeholder.
          setFleetPoints([]);
        }
      });
    return () => controller.abort();
  }, []);

  // Still loading → show nothing (avoids layout shift).
  if (fleetPoints === null) return null;

  // Insufficient data → minimal placeholder.
  if (fleetPoints.length < 2) {
    return (
      <span
        className="font-mono text-[11px]"
        style={{ color: 'var(--ink-4)' }}
        aria-label="no trend data yet"
      >
        —
      </span>
    );
  }

  return (
    <div style={{ width: '100%', paddingTop: '4px', paddingBottom: '4px' }}>
      <AreaSparkline
        points={fleetPoints}
        width={240}
        height={28}
        color="var(--c1)"
      />
    </div>
  );
}
