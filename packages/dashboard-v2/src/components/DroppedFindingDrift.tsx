import type { OverviewData } from '@/lib/types';

// Deterministic color picker from a palette — no hash randomness to keep
// the same type the same color across renders.
// bg-unique and bg-confirmed are kept as Tailwind classes (non-theme-sensitive semantic tokens).
// Theme-sensitive tokens (primary, muted-foreground) are expressed as CSS var() strings.
const PALETTE_BG: string[] = [
  'color-mix(in oklch, var(--accent) 70%, transparent)',
  '',  // bg-cyan-500/60 — non-theme, handled via PALETTE_CLASS
  '',  // bg-unique — handled via PALETTE_CLASS
  'color-mix(in oklch, var(--text-dim) 60%, transparent)',
  'color-mix(in oklch, var(--accent) 50%, transparent)',
  '',  // bg-confirmed/70 — handled via PALETTE_CLASS
];
const PALETTE_CLASS: string[] = [
  '',
  'bg-cyan-500/60',
  'bg-unique',
  '',
  '',
  'bg-confirmed/70',
];

function colorIndex(type: string): number {
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return h % PALETTE_BG.length;
}

function colorBgStyle(type: string): string | undefined {
  return PALETTE_BG[colorIndex(type)] || undefined;
}

function colorClass(type: string): string {
  return PALETTE_CLASS[colorIndex(type)] || '';
}

export function DroppedFindingDrift({ overview }: { overview: OverviewData | null }) {
  const counts = overview?.droppedFindingTypeCounts;
  const entries = counts ? Object.entries(counts).sort((a, b) => b[1] - a[1]) : [];
  const total = entries.reduce((acc, [, n]) => acc + n, 0);

  return (
    <section className="rounded-lg border border-border p-4" style={{ background: 'var(--surface-elev)' }}>
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="h-section">Invalid Output Types<span className="font-normal normal-case ml-2" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>agent_finding tags rejected by the parser</span></h3>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>last 20 rounds</span>
      </header>
      {total === 0 ? (
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>all clean — no invalid types</p>
      ) : (
        <>
          <div className="mb-3 flex h-3 w-full overflow-hidden rounded">
            {entries.map(([type, n]) => {
              const pct = (n / total) * 100;
              return (
                <div
                  key={type}
                  className={colorClass(type)}
                  style={{ width: `${pct}%`, ...(colorBgStyle(type) ? { background: colorBgStyle(type) } : {}) }}
                  title={`invalid type "${type}" emitted ${n} times in last 20 consensus rounds`}
                />
              );
            })}
          </div>
          <ul className="space-y-1 text-xs">
            {entries.map(([type, n]) => (
              <li key={type} className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-sm ${colorClass(type)}`}
                  style={colorBgStyle(type) ? { background: colorBgStyle(type) } : undefined}
                />
                <span className="truncate font-mono" style={{ color: 'var(--text)' }}>{type}</span>
                <span className="ml-auto tabular-nums" style={{ color: 'var(--text-dim)' }}>{n}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
