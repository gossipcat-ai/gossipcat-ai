/**
 * 7-day signal-volume area sparkline.
 *
 * Design rules (DESIGN.md Step 6):
 * - ~80×20px inline SVG. --c1 stroke + 0.3 opacity fill.
 * - Delta badge: last 3.5d vs first 3.5d, +/-N% with --ok/--bad.
 * - Empty: flat baseline (no error, no hidden element).
 * - prefers-reduced-motion: area fill suppressed, path still shown.
 */

import React, { useMemo } from 'react';
import type { FleetTrendPoint } from '@/lib/types';

interface AreaSparklineProps {
  /** Points for a single agent, sorted ascending by day. */
  points: FleetTrendPoint[];
  width?: number;
  height?: number;
  /** When true (CSS prefers-reduced-motion), area fill is suppressed. */
  reducedMotion?: boolean;
}

function toSignals(points: FleetTrendPoint[]): number[] {
  return points.map((p) => p.signals);
}

function buildPath(values: number[], W: number, H: number): { line: string; area: string } {
  if (values.length === 0) {
    const flat = `M 0 ${H} L ${W} ${H}`;
    return { line: flat, area: '' };
  }
  if (values.length === 1) {
    const y = H / 2;
    return {
      line: `M 0 ${y} L ${W} ${y}`,
      area: `M 0 ${H} L 0 ${y} L ${W} ${y} L ${W} ${H} Z`,
    };
  }
  const max = Math.max(...values, 1);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = (i * step).toFixed(2);
    const y = (H - (v / max) * H).toFixed(2);
    return `${x},${y}`;
  });
  const line = `M ${pts.join(' L ')}`;
  const area = `M 0,${H} L ${pts.join(' L ')} L ${((values.length - 1) * step).toFixed(2)},${H} Z`;
  return { line, area };
}

function deltaPercent(points: FleetTrendPoint[]): number | null {
  if (points.length < 2) return null;
  const half = Math.floor(points.length / 2);
  const first = points.slice(0, half);
  const last = points.slice(points.length - half);
  const avg = (arr: FleetTrendPoint[]) =>
    arr.reduce((sum, p) => sum + p.signals, 0) / arr.length;
  const a = avg(first);
  const b = avg(last);
  if (a === 0) return b === 0 ? 0 : 100;
  return Math.round(((b - a) / a) * 100);
}

export function AreaSparkline({
  points,
  width = 80,
  height = 20,
  reducedMotion = false,
}: AreaSparklineProps) {
  const values = useMemo(() => toSignals(points), [points]);
  const { line, area } = useMemo(() => buildPath(values, width, height), [values, width, height]);
  const delta = useMemo(() => deltaPercent(points), [points]);

  const isEmpty = values.length === 0 || values.every((v) => v === 0);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        style={{ overflow: 'visible', flexShrink: 0 }}
      >
        {/* Area fill — suppressed when reducedMotion */}
        {!reducedMotion && !isEmpty && area && (
          <path
            d={area}
            fill="var(--c1)"
            fillOpacity={0.3}
          />
        )}
        {/* Line */}
        <path
          d={line}
          fill="none"
          stroke={isEmpty ? 'var(--idle)' : 'var(--c1)'}
          strokeOpacity={isEmpty ? 0.3 : 1}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {delta !== null && !isEmpty && (
        <span
          style={{
            fontSize: 10,
            fontFamily: 'Geist, Inter, sans-serif',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 600,
            color: delta >= 0 ? 'var(--ok)' : 'var(--bad)',
            flexShrink: 0,
          }}
        >
          {delta >= 0 ? '+' : ''}{delta}%
        </span>
      )}
    </div>
  );
}
