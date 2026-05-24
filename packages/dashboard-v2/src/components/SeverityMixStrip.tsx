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

const SEGMENT_COLORS: Record<keyof SeverityCount, string> = {
  critical: 'var(--bad)',
  high: 'var(--warn)',
  medium: 'var(--info)',
  low: 'var(--idle)',
};

const SEVERITY_ORDER: Array<keyof SeverityCount> = ['critical', 'high', 'medium', 'low'];

export function SeverityMixStrip({ counts, height = 7 }: SeverityMixStripProps) {
  const c = counts ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const total = c.critical + c.high + c.medium + c.low;
  const title = `critical: ${c.critical}, high: ${c.high}, medium: ${c.medium}, low: ${c.low}`;

  if (total === 0) {
    return (
      <div
        title={title}
        style={{
          height,
          borderRadius: height / 2,
          background: 'var(--idle)',
          opacity: 0.25,
        }}
      />
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
              background: SEGMENT_COLORS[sev],
              flexShrink: 0,
            }}
          />
        );
      })}
    </div>
  );
}
