import type { OverviewData } from '@/lib/types';

// Semantic palette — green=good, red=bad, blue=active/in-progress,
// yellow=needs attention, orange=stuck, gray=quiet. Uses /15-/20 bg tones
// for chips + solid text so the legend reads at dashboard scale.
const SEGMENTS: {
  key: keyof NonNullable<OverviewData['skillVerdictSummary']>;
  label: string;
  color: string;
}[] = [
  { key: 'passed',                label: 'passed',        color: 'var(--ok)' },
  { key: 'pending',               label: 'pending',       color: 'var(--info)' },
  { key: 'insufficient_evidence', label: 'insufficient',  color: 'var(--idle)' },
  { key: 'inconclusive',          label: 'inconclusive',  color: 'var(--warn)' },
  { key: 'silent_skill',          label: 'silent',        color: 'var(--ink-3)' },
  { key: 'failed',                label: 'failed',        color: 'var(--bad)' },
];

export function SkillVerdictsSnapshot({ overview }: { overview: OverviewData | null }) {
  const s = overview?.skillVerdictSummary;
  const total = s ? SEGMENTS.reduce((acc, seg) => acc + (s[seg.key] ?? 0), 0) : 0;

  return (
    <section className="rounded-lg border border-border p-4" style={{ background: 'var(--surface-elev)' }}>
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="h-section">
          Skill Verdicts
        </h3>
        <span className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>{total} total</span>
      </header>
      {!s || total === 0 ? (
        <p className="font-mono text-[11px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>no skill verdicts yet</p>
      ) : (
        <>
          <div className="mb-3 flex h-2 w-full gap-px overflow-hidden rounded-sm" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 40%, transparent)' }}>
            {SEGMENTS.map((seg) => {
              const n = s[seg.key] ?? 0;
              if (n === 0) return null;
              const pct = (n / total) * 100;
              return (
                <div
                  key={seg.key}
                  style={{ width: `${pct}%`, background: seg.color }}
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
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: seg.color }} />
                  <span style={{ color: 'var(--text-dim)' }}>{seg.label}</span>
                  <span
                    className="ml-auto tabular-nums"
                    style={muted ? { color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' } : { color: seg.color }}
                  >
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
