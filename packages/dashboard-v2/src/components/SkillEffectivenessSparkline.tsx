import { useMemo } from 'react';
import type { SkillCurvePoint } from '@/lib/types';

/**
 * DESIGN.md Step 9.5 — per-skill post-bind effectiveness sparkline.
 *
 * Single stroke path + dashed horizontal threshold line. No fill.
 * Gaps (windows with no signals → value === null) split the path so the line
 * doesn't lie about coverage. The verdict color (--ok / --info / --bad / etc.)
 * is supplied by the parent so we never bake a palette decision in here.
 *
 * Sizing: defaults to 140×30 (matches the mockup density). Caller can override
 * via props but the dashed threshold and gap-splitting logic don't care.
 */

interface Props {
  curve: SkillCurvePoint[];
  /** [0, 1] horizontal line. Default 0.7 (HANDBOOK invariant). */
  threshold: number;
  /** Stroke color for the curve. Should be the verdict color. */
  stroke: string;
  width?: number;
  height?: number;
}

const PADDING_X = 1;
const PADDING_Y = 2;

export function SkillEffectivenessSparkline({
  curve,
  threshold,
  stroke,
  width = 140,
  height = 30,
}: Props) {
  // Split the curve into contiguous defined-value runs so SVG `M ... L ...`
  // segments don't visually bridge gaps. Each run becomes one <path>.
  const segments = useMemo(() => splitSegments(curve), [curve]);

  if (curve.length === 0) {
    return <EmptySparkline width={width} height={height} />;
  }

  const innerW = width - PADDING_X * 2;
  const innerH = height - PADDING_Y * 2;
  const thresholdY = PADDING_Y + (1 - clamp01(threshold)) * innerH;

  const xFor = (i: number): number => {
    if (curve.length <= 1) return PADDING_X + innerW / 2;
    return PADDING_X + (i / (curve.length - 1)) * innerW;
  };
  const yFor = (v: number): number => PADDING_Y + (1 - clamp01(v)) * innerH;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      style={{ display: 'block' }}
    >
      {/* Threshold line — dashed, ink-4 stroke. */}
      <line
        x1={PADDING_X}
        x2={width - PADDING_X}
        y1={thresholdY}
        y2={thresholdY}
        stroke="var(--ink-4)"
        strokeWidth={1}
        strokeDasharray="2 3"
        opacity={0.7}
      />
      {/* One stroke path per contiguous segment of non-null values. */}
      {segments.map((seg, i) => {
        if (seg.length === 1) {
          // Single point: draw a tiny circle so it's visible.
          const { idx, value } = seg[0];
          return (
            <circle
              key={i}
              cx={xFor(idx)}
              cy={yFor(value)}
              r={1.4}
              fill={stroke}
            />
          );
        }
        const d = seg
          .map((p, j) => `${j === 0 ? 'M' : 'L'} ${xFor(p.idx).toFixed(2)} ${yFor(p.value).toFixed(2)}`)
          .join(' ');
        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

function EmptySparkline({ width, height }: { width: number; height: number }) {
  // Render the threshold dashed line only — keeps the row height stable while
  // signaling "no post-bind signals yet."
  const thresholdY = height / 2;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      style={{ display: 'block' }}
    >
      <line
        x1={PADDING_X}
        x2={width - PADDING_X}
        y1={thresholdY}
        y2={thresholdY}
        stroke="var(--ink-4)"
        strokeWidth={1}
        strokeDasharray="2 3"
        opacity={0.5}
      />
    </svg>
  );
}

function splitSegments(curve: SkillCurvePoint[]): Array<Array<{ idx: number; value: number }>> {
  const out: Array<Array<{ idx: number; value: number }>> = [];
  let cur: Array<{ idx: number; value: number }> = [];
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i].value;
    if (v == null || !Number.isFinite(v)) {
      if (cur.length > 0) { out.push(cur); cur = []; }
      continue;
    }
    cur.push({ idx: i, value: v });
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
