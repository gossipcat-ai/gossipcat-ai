import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { FleetTrendPoint, FleetTrendResponse } from '@/lib/types';
import { EmptyState } from './EmptyState';

interface AgentSeries {
  agentId: string;
  points: FleetTrendPoint[];
  latest: number;
}

function groupByAgent(points: FleetTrendPoint[]): AgentSeries[] {
  const map = new Map<string, FleetTrendPoint[]>();
  for (const p of points) {
    const arr = map.get(p.agentId) ?? [];
    arr.push(p);
    map.set(p.agentId, arr);
  }
  const series: AgentSeries[] = [];
  for (const [agentId, arr] of map) {
    arr.sort((a, b) => a.day.localeCompare(b.day));
    const latest = arr.length > 0 ? arr[arr.length - 1].accuracy : 0;
    series.push({ agentId, points: arr, latest });
  }
  series.sort((a, b) => b.latest - a.latest);
  return series;
}

function Sparkline({ values }: { values: number[] }) {
  const W = 120;
  const H = 20;
  if (values.length === 0) return <svg width={W} height={H} />;
  if (values.length === 1) {
    const y = H - values[0] * H;
    return (
      <svg width={W} height={H}>
        <circle cx={W / 2} cy={y} r={2} fill="currentColor" />
      </svg>
    );
  }
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - v * H).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} className="text-primary">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

export function FleetHealthTrend() {
  const [data, setData] = useState<FleetTrendResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<FleetTrendResponse>('fleet-trend?days=30')
      .then(setData)
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  const series = useMemo(() => (data ? groupByAgent(data.points) : []), [data]);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">Fleet Health Trend</h3>
        <span className="text-xs text-muted-foreground">last 30d</span>
      </header>
      {!data && !err && <EmptyState title="Loading…" compact />}
      {err && <p className="text-xs text-muted-foreground">failed to load trend data</p>}
      {!err && data && series.length === 0 && (
        <p className="text-xs text-muted-foreground">no recent consensus signals</p>
      )}
      {!err && series.length > 0 && (
        <ul className="space-y-1.5">
          {series.map((s) => (
            <li key={s.agentId} className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-mono text-foreground">{s.agentId}</span>
              <div className="flex items-center gap-2">
                <Sparkline values={s.points.map((p) => p.accuracy)} />
                <span className="w-10 text-right tabular-nums text-muted-foreground">
                  {Math.round(s.latest * 100)}%
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
