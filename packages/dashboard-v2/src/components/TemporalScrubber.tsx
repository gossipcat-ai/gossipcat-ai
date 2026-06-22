import { useEffect, useMemo, useState } from 'react';
import { bucketize, BUCKET_COUNT, rangeWindowMs } from '@/lib/histogram';
import type { Range } from '@/lib/range-param';
import type { ConsensusRun } from '@/lib/types';

interface TemporalScrubberProps {
  runs: ConsensusRun[];
  range: Range;
  onRangeChange: (r: Range) => void;
  height?: number; // default 52, per spec
}

const RANGES: Range[] = ['1h', '24h', '7d', '30d'];

/** Human label for the left flank — "1 hour ago" / "24 hours ago" / "7 days ago" / "30 days ago". */
const RANGE_AGO_LABEL: Record<Range, string> = {
  '1h': '1h ago',
  '24h': '24h ago',
  '7d': '7d ago',
  '30d': '30d ago',
};

export function TemporalScrubber({ runs, range, onRangeChange, height = 52 }: TemporalScrubberProps) {
  // `nowMs` ticks at the bucket interval so the histogram doesn't freeze
  // while real time advances without new data. One bucket-width per tick
  // is sufficient — finer resolution would re-render needlessly.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const bucketMs = rangeWindowMs(range) / BUCKET_COUNT;
    const id = window.setInterval(() => setNowMs(Date.now()), bucketMs);
    return () => window.clearInterval(id);
  }, [range]);

  const buckets = useMemo(() => {
    // Each round contributes signals.length timestamps (using the round's ts).
    const timestamps: string[] = [];
    for (const r of runs) {
      const n = r.signals?.length ?? 0;
      for (let i = 0; i < n; i++) timestamps.push(r.timestamp);
    }
    return bucketize(timestamps, range, nowMs);
  }, [runs, range, nowMs]);

  const max = Math.max(1, ...buckets);

  return (
    <div
      className="rounded-md border px-3 py-2"
      style={{ background: 'var(--surface-elev)', borderColor: 'var(--border)' }}
    >
      {/* Top row: section label + range selector */}
      <div className="mb-2 flex items-center justify-between">
        <div className="h-section">Signal volume</div>
        <div className="flex gap-1">
          {RANGES.map((r) => {
            const active = r === range;
            return (
              <button
                key={r}
                type="button"
                onClick={() => onRangeChange(r)}
                aria-pressed={active}
                className="rounded px-2 py-0.5 font-mono text-[10px] transition"
                style={{
                  // Filter chips are interactive chrome, not CTAs — DESIGN.md
                  // reserves --accent for brand mark / primary CTA / active nav.
                  // Selected state uses weight + surface, not the brand hue.
                  background: active ? 'var(--surface-sunk)' : 'transparent',
                  color: active ? 'var(--text)' : 'var(--text-dim)',
                  border: '1px solid',
                  borderColor: active ? 'var(--border-strong)' : 'transparent',
                }}
              >
                {r}
              </button>
            );
          })}
        </div>
      </div>

      {/* Full-width bar chart — uses chart-palette --c1 (teal) instead of
          --accent per DESIGN.md (chart bars never use accent). Bars get a
          subtle baseline row, rounded caps, and a hover-friendly gap. */}
      <svg
        viewBox={`0 0 ${BUCKET_COUNT} 1`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, color: 'var(--c1)', display: 'block' }}
      >
        {/* Baseline track — faint axis at the bottom so empty buckets read as zero */}
        <rect x={0} y={0.985} width={BUCKET_COUNT} height={0.015} fill="var(--ink)" opacity={0.08} />
        {buckets.map((c, i) => {
          const h = c === 0 ? 0 : (c / max);
          const y = 1 - h;
          return (
            <rect
              key={i}
              x={i + 0.15}
              y={y}
              width={0.7}
              height={Math.max(h, c > 0 ? 0.04 : 0)}
              rx={0.06}
              ry={0.06}
              fill="currentColor"
              opacity={c === 0 ? 0 : 0.9}
            />
          );
        })}
      </svg>

      {/* X-axis labels: oldest (left) → now (right) */}
      <div className="mt-1 flex items-center justify-between font-mono text-[10px] tabular-nums" style={{ color: 'var(--ink-3)' }}>
        <span>{RANGE_AGO_LABEL[range]}</span>
        <span>now</span>
      </div>
    </div>
  );
}
