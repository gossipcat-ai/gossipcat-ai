/**
 * 4-segment horizontal stacked bar showing severity distribution.
 *
 * Design rules (DESIGN.md Step 6):
 * - ~6-8px height, segments proportional by count.
 * - Colors: critical=--bad, high=--warn, medium=--info, low=--idle.
 * - Empty (all zero): full --idle track.
 * - title attr = raw counts for screen-reader / hover tooltip.
 */

import React from 'react';
import type { SeverityCount } from '@/hooks/useSeverityCounts';

interface SeverityMixStripProps {
  counts?: SeverityCount;
  height?: number;
}

/** Monochrome opacity ramp — single rose hue ramping from dark
 *  (critical) to light (low) reads as "severity intensity" without
 *  collisions with the verdict/status semantic palette elsewhere. */
const SEGMENT_COLOR = 'var(--bad)';
const SEGMENT_OPACITY: Record<keyof SeverityCount, number> = {
  critical: 1.0,
  high: 0.7,
  medium: 0.45,
  low: 0.22,
};

const SEVERITY_ORDER: Array<keyof SeverityCount> = ['critical', 'high', 'medium', 'low'];

export function SeverityMixStrip({ counts, height = 10 }: SeverityMixStripProps) {
  const c = counts ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const total = c.critical + c.high + c.medium + c.low;
  const title = `critical: ${c.critical}, high: ${c.high}, medium: ${c.medium}, low: ${c.low}`;

  if (total === 0) {
    // Empty state — 4 placeholder segments visible enough to convey the
    // future shape. Higher opacity + border so it reads in both themes.
    return (
      <div
        title={`${title} (no findings yet)`}
        style={{
          display: 'flex',
          height,
          borderRadius: height / 2,
          overflow: 'hidden',
          gap: 2,
          border: '1px solid color-mix(in oklch, var(--border) 60%, transparent)',
          width: '100%',
        }}
      >
        {SEVERITY_ORDER.map((sev) => (
          <div
            key={sev}
            style={{
              flex: 1,
              background: SEGMENT_COLOR,
              opacity: SEGMENT_OPACITY[sev] * 0.5,
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      title={title}
      style={{
        display: 'flex',
        height,
        borderRadius: height / 2,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      {SEVERITY_ORDER.map((sev) => {
        const count = c[sev];
        if (count === 0) return null;
        const pct = (count / total) * 100;
        return (
          <div
            key={sev}
            style={{
              width: `${pct.toFixed(2)}%`,
              background: SEGMENT_COLOR,
              opacity: SEGMENT_OPACITY[sev],
              flexShrink: 0,
            }}
          />
        );
      })}
    </div>
  );
}
