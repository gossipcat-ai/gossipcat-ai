/**
 * 90×90 polar accuracy gauge (SVG).
 *
 * Design rules (DESIGN.md Step 6 v1.1):
 * - Single arc 0→360° × accuracy. Track at 8% opacity --ink.
 * - Stroke uses per-agent identity color (passed via `color` prop).
 * - Percentage label in Fraunces tabular-nums at center.
 * - "ACCURACY" label rendered below the gauge.
 */

import React from 'react';

interface PolarAccuracyGaugeProps {
  accuracy: number;
  size?: number;
  /** Per-agent identity color. Defaults to neutral ink. */
  color?: string;
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

export function PolarAccuracyGauge({ accuracy, size = 90, color = 'var(--ink)' }: PolarAccuracyGaugeProps) {
  const v = Number.isFinite(accuracy) ? Math.max(0, Math.min(1, accuracy)) : 0;
  const cx = size / 2;
  const cy = size / 2;
  const strokeWidth = size * 0.089;
  const r = (size - strokeWidth) / 2 - 2;
  const pct = Math.round(v * 100);
  const fontSize = Math.round(size * 0.22);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Accuracy ${pct}%`}
      >
        <path
          d={circlePath(cx, cy, r)}
          fill="none"
          stroke="var(--ink)"
          strokeOpacity={0.08}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {v > 0 && (
          <path
            d={arcPath(cx, cy, r, v)}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        )}
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--ink)"
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
      <span
        style={{
          fontSize: 9,
          color: 'var(--ink-3)',
          fontFamily: 'Geist, Inter, sans-serif',
          fontVariant: 'small-caps',
          letterSpacing: '0.04em',
        }}
      >
        accuracy
      </span>
    </div>
  );
}
