import { useMemo } from 'react';
import { bucketize, BUCKET_COUNT } from '@/lib/histogram';
import type { Range } from '@/lib/range-param';
import type { ConsensusRun } from '@/lib/types';

interface TemporalScrubberProps {
  runs: ConsensusRun[];
  range: Range;
  onRangeChange: (r: Range) => void;
  height?: number; // default 52, per spec
}

const RANGES: Range[] = ['1h', '24h', '7d', '30d'];

export function TemporalScrubber({ runs, range, onRangeChange, height = 52 }: TemporalScrubberProps) {
  const buckets = useMemo(() => {
    // Each round contributes signals.length timestamps (using the round's ts).
    const timestamps: string[] = [];
    for (const r of runs) {
      const n = r.signals?.length ?? 0;
      for (let i = 0; i < n; i++) timestamps.push(r.timestamp);
    }
    return bucketize(timestamps, range, Date.now());
  }, [runs, range]);

  const max = Math.max(1, ...buckets);

  return (
    <div
      className="flex items-center gap-3 rounded-md border px-3 py-2"
      style={{ background: 'var(--surface-elev)', borderColor: 'var(--border)' }}
    >
      <div className="font-mono text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-faint)' }}>
        Signal volume
      </div>
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
              opacity={c === 0 ? 0.08 : 0.85}
            />
          );
        })}
      </svg>
      <div className="flex gap-1">
        {RANGES.map((r) => {
          const active = r === range;
          return (
            <button
              key={r}
              type="button"
              onClick={() => onRangeChange(r)}
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
