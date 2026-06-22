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
/** Minimum non-null buckets before the curve renders. Below this the
 *  threshold-only placeholder shows — N + verdict label carry the info.
 *  Set to 5 (half of the 10-bucket window) so sparse data with big gaps
 *  collapses to the clean dashed line instead of fragmented stubs. */
const MIN_VISIBLE_POINTS = 5;

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

  // Total non-null buckets across all segments. Below MIN_VISIBLE_POINTS the
  // curve renders as floating dots/short stubs, which reads as broken noise
  // rather than "early signal." Fall back to the threshold-only placeholder.
  const definedCount = segments.reduce((n, s) => n + s.length, 0);
  if (curve.length === 0 || definedCount < MIN_VISIBLE_POINTS) {
    return <EmptySparkline width={width} height={height} threshold={threshold} />;
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
              className="skill-spark-curve"
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
            className="skill-spark-curve"
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

function EmptySparkline({ width, height, threshold }: { width: number; height: number; threshold?: number }) {
  // Render the threshold dashed line only — keeps the row height stable while
  // signaling "no post-bind signals yet."
  // When threshold is defined, position the line at the correct ratio so it
  // matches where the live sparkline would draw its dashed reference.
  const innerH = height - PADDING_Y * 2;
  const thresholdY =
    threshold !== undefined
      ? PADDING_Y + (1 - clamp01(threshold)) * innerH
      : height / 2;
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
        stroke="var(--ok)"
        strokeWidth={1}
        strokeDasharray="2 2"
        opacity={0.4}
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
