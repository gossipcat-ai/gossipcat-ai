import type { OverviewData } from '@/lib/types';

// Deterministic color picker from a palette — no hash randomness to keep
// the same type the same color across renders.
const PALETTE = [
  'bg-primary/70',
  'bg-cyan-500/60',
  'bg-unique',
  'bg-muted-foreground/60',
  'bg-primary/50',
  'bg-confirmed/70',
];

function colorFor(type: string): string {
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function DroppedFindingDrift({ overview }: { overview: OverviewData | null }) {
  const counts = overview?.droppedFindingTypeCounts;
  const entries = counts ? Object.entries(counts).sort((a, b) => b[1] - a[1]) : [];
  const total = entries.reduce((acc, [, n]) => acc + n, 0);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">Invalid Output Types<span className="text-muted-foreground/50 font-normal normal-case ml-2">agent_finding tags rejected by the parser</span></h3>
        <span className="text-xs text-muted-foreground">last 20 rounds</span>
      </header>
      {total === 0 ? (
        <p className="text-xs text-muted-foreground">all clean — no invalid types</p>
      ) : (
        <>
          <div className="mb-3 flex h-3 w-full overflow-hidden rounded">
            {entries.map(([type, n]) => {
              const pct = (n / total) * 100;
              return (
                <div
                  key={type}
                  className={colorFor(type)}
                  style={{ width: `${pct}%` }}
                  title={`invalid type "${type}" emitted ${n} times in last 20 consensus rounds`}
                />
              );
            })}
          </div>
          <ul className="space-y-1 text-xs">
            {entries.map(([type, n]) => (
              <li key={type} className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-sm ${colorFor(type)}`} />
                <span className="truncate font-mono text-foreground">{type}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{n}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
