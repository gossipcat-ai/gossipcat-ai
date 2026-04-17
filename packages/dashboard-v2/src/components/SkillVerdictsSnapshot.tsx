import type { OverviewData } from '@/lib/types';

const SEGMENTS: { key: keyof NonNullable<OverviewData['skillVerdictSummary']>; label: string; cls: string }[] = [
  { key: 'passed', label: 'passed', cls: 'bg-confirmed' },
  { key: 'pending', label: 'pending', cls: 'bg-unique/60' },
  { key: 'silent_skill', label: 'silent', cls: 'bg-unverified' },
  { key: 'insufficient_evidence', label: 'insufficient', cls: 'bg-muted' },
  { key: 'inconclusive', label: 'inconclusive', cls: 'bg-muted-foreground/40' },
  { key: 'failed', label: 'failed', cls: 'bg-disputed' },
];

export function SkillVerdictsSnapshot({ overview }: { overview: OverviewData | null }) {
  const s = overview?.skillVerdictSummary;
  const total = s ? SEGMENTS.reduce((acc, seg) => acc + (s[seg.key] ?? 0), 0) : 0;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Skill Verdicts</h3>
        <span className="text-xs text-muted-foreground">{total} total</span>
      </header>
      {!s || total === 0 ? (
        <p className="text-xs text-muted-foreground">no skill verdicts yet</p>
      ) : (
        <>
          <div className="mb-3 flex h-3 w-full overflow-hidden rounded">
            {SEGMENTS.map((seg) => {
              const n = s[seg.key] ?? 0;
              if (n === 0) return null;
              const pct = (n / total) * 100;
              return (
                <div
                  key={seg.key}
                  className={seg.cls}
                  style={{ width: `${pct}%` }}
                  title={`${seg.label}: ${n}`}
                />
              );
            })}
          </div>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {SEGMENTS.map((seg) => {
              const n = s[seg.key] ?? 0;
              return (
                <li key={seg.key} className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-sm ${seg.cls}`} />
                  <span className="text-muted-foreground">{seg.label}</span>
                  <span className="ml-auto tabular-nums text-foreground">{n}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
