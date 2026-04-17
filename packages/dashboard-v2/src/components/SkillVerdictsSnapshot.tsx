import type { OverviewData } from '@/lib/types';

// Semantic palette — green=good, red=bad, blue=active/in-progress,
// yellow=needs attention, orange=stuck, gray=quiet. Uses /15-/20 bg tones
// for chips + solid text so the legend reads at dashboard scale.
const SEGMENTS: {
  key: keyof NonNullable<OverviewData['skillVerdictSummary']>;
  label: string;
  bar: string;
  dot: string;
  text: string;
}[] = [
  { key: 'passed',                label: 'passed',        bar: 'bg-emerald-400',  dot: 'bg-emerald-400',  text: 'text-emerald-400' },
  { key: 'pending',               label: 'pending',       bar: 'bg-sky-400',      dot: 'bg-sky-400',      text: 'text-sky-400' },
  { key: 'insufficient_evidence', label: 'insufficient',  bar: 'bg-yellow-400',   dot: 'bg-yellow-400',   text: 'text-yellow-400' },
  { key: 'inconclusive',          label: 'inconclusive',  bar: 'bg-orange-400',   dot: 'bg-orange-400',   text: 'text-orange-400' },
  { key: 'silent_skill',          label: 'silent',        bar: 'bg-zinc-500',     dot: 'bg-zinc-500',     text: 'text-zinc-400' },
  { key: 'failed',                label: 'failed',        bar: 'bg-red-400',      dot: 'bg-red-400',      text: 'text-red-400' },
];

export function SkillVerdictsSnapshot({ overview }: { overview: OverviewData | null }) {
  const s = overview?.skillVerdictSummary;
  const total = s ? SEGMENTS.reduce((acc, seg) => acc + (s[seg.key] ?? 0), 0) : 0;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
          Skill Verdicts
        </h3>
        <span className="font-mono text-[10px] text-muted-foreground/70">{total} total</span>
      </header>
      {!s || total === 0 ? (
        <p className="font-mono text-[11px] text-muted-foreground/60">no skill verdicts yet</p>
      ) : (
        <>
          <div className="mb-3 flex h-2 w-full gap-px overflow-hidden rounded-sm bg-muted/40">
            {SEGMENTS.map((seg) => {
              const n = s[seg.key] ?? 0;
              if (n === 0) return null;
              const pct = (n / total) * 100;
              return (
                <div
                  key={seg.key}
                  className={seg.bar}
                  style={{ width: `${pct}%` }}
                  title={`${seg.label}: ${n}`}
                />
              );
            })}
          </div>
          <ul className="grid grid-cols-3 gap-x-4 gap-y-1.5 font-mono text-[11px]">
            {SEGMENTS.map((seg) => {
              const n = s[seg.key] ?? 0;
              const muted = n === 0;
              return (
                <li key={seg.key} className={`flex items-center gap-1.5 ${muted ? 'opacity-40' : ''}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${seg.dot}`} />
                  <span className="text-muted-foreground">{seg.label}</span>
                  <span className={`ml-auto tabular-nums ${muted ? 'text-muted-foreground/50' : seg.text}`}>
                    {n}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
