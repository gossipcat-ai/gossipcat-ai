/**
 * 90×90 polar accuracy gauge (SVG).
 *
 * Design rules (DESIGN.md Step 6):
 * - Single arc 0→360° × accuracy. Track at 8% opacity --ink.
 * - Stroke is status-semantic: --ok ≥0.7, --warn 0.4–0.7, --bad <0.4.
 * - Percentage label in Fraunces tabular-nums at center.
 * - No drop shadows, no per-agent color.
 */

import React from 'react';

interface PolarAccuracyGaugeProps {
  accuracy: number;
  size?: number;
}

function gaugeColor(accuracy: number): string {
  if (accuracy >= 0.7) return 'var(--ok)';
  if (accuracy >= 0.4) return 'var(--warn)';
  return 'var(--bad)';
}

/**
 * Compute SVG arc path for a partial circle.
 * Angles are measured clockwise from 12 o'clock (top).
 * fraction: 0→1 (1 = full circle).
 */
function arcPath(cx: number, cy: number, r: number, fraction: number): string {
  // Clamp to avoid degenerate full-circle path
  const clipped = Math.max(0, Math.min(0.9999, fraction));
  const startAngle = -Math.PI / 2; // 12 o'clock
  const endAngle = startAngle + clipped * 2 * Math.PI;
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const largeArc = clipped > 0.5 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Full circle track path */
function circlePath(cx: number, cy: number, r: number): string {
  // Two half-arcs to form a closed circle
  return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r}`;
}

export function PolarAccuracyGauge({ accuracy, size = 90 }: PolarAccuracyGaugeProps) {
  const v = Number.isFinite(accuracy) ? Math.max(0, Math.min(1, accuracy)) : 0;
  const cx = size / 2;
  const cy = size / 2;
  const strokeWidth = size * 0.089; // ~8px at 90
  const r = (size - strokeWidth) / 2 - 2;
  const color = gaugeColor(v);
  const pct = Math.round(v * 100);

  // Fraunces font-size proportional to gauge size
  const fontSize = Math.round(size * 0.22);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Accuracy ${pct}%`}
    >
      {/* Track — full circle at 8% opacity ink */}
      <path
        d={circlePath(cx, cy, r)}
        fill="none"
        stroke="var(--ink)"
        strokeOpacity={0.08}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {/* Arc — accuracy fraction, status semantic */}
      {v > 0 && (
        <path
          d={arcPath(cx, cy, r, v)}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      )}
      {/* Percentage label — Fraunces at center */}
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        style={{
          fontSize,
          fontFamily: "'Fraunces', serif",
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 700,
        }}
      >
        {pct}%
      </text>
    </svg>
  );
}
