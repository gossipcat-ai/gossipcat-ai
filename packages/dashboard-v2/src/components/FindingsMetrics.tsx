import type { OverviewData, ConsensusData } from '@/lib/types';

interface FindingsMetricsProps {
  overview: OverviewData;
  consensus: ConsensusData;
}

export function FindingsMetrics({ overview, consensus }: FindingsMetricsProps) {
  const confirmed = overview.confirmedFindings;
  const total = overview.totalFindings;
  const actionable = overview.actionableFindings;
  const unverified = total - confirmed - actionable;
  const unique = consensus.runs.reduce((sum, r) => sum + (r.counts.unique || 0), 0);
  const disputed = actionable;

  const metrics = [
    { label: 'Confirmed', value: confirmed, color: 'bg-confirmed', textColor: 'text-confirmed' },
    { label: 'Disputed', value: disputed, color: 'bg-disputed', textColor: 'text-disputed' },
    { label: 'Unverified', value: Math.max(0, unverified), color: 'bg-unverified', textColor: 'text-unverified' },
    { label: 'Unique', value: unique, color: 'bg-unique', textColor: 'text-unique' },
  ];

  const barTotal = metrics.reduce((s, m) => s + m.value, 0) || 1;

  return (
    <section>
      <h2 className="mb-4 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
        Findings <span className="text-primary">{total}</span>
      </h2>
      <div className="grid grid-cols-4 gap-3">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-md border border-border bg-card p-4">
            <div className={`font-mono text-2xl font-bold ${m.textColor}`}>{m.value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{m.label}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex h-2 overflow-hidden rounded-sm">
        {metrics.map((m) => (
          m.value > 0 && (
            <div
              key={m.label}
              className={`${m.color} transition-all`}
              style={{ width: `${(m.value / barTotal) * 100}%` }}
            />
          )
        ))}
      </div>
    </section>
  );
}
