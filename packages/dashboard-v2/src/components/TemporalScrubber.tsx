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
      className="flex items-center gap-3 rounded-md border px-3 py-2"
      style={{ background: 'var(--surface-elev)', borderColor: 'var(--border)' }}
    >
      <div className="h-section">
        Signal volume
      </div>
      <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--ink-3)' }}>{RANGE_AGO_LABEL[range]}</span>
      <svg
        viewBox={`0 0 ${BUCKET_COUNT} 1`}
        preserveAspectRatio="none"
        style={{ flex: 1, height, color: 'var(--accent)' }}
      >
        {buckets.map((c, i) => {
          const h = c === 0 ? 0 : (c / max);
          const y = 1 - h;
          return (
            <rect
              key={i}
              x={i + 0.1}
              y={y}
              width={0.8}
              height={Math.max(h, c > 0 ? 0.04 : 0)}
              fill="currentColor"
              opacity={c === 0 ? 0.15 : 0.85}
            />
          );
        })}
      </svg>
      <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--ink-3)' }}>now</span>
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
                background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-dim)',
                border: '1px solid',
                borderColor: active ? 'color-mix(in oklch, var(--accent) 30%, transparent)' : 'transparent',
              }}
            >
              {r}
            </button>
          );
        })}
      </div>
    </div>
  );
}
