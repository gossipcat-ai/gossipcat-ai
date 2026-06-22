/**
 * AgentCardBig — Step 6 v1.1 (DESIGN.md).
 *
 * Two-column layout:
 * - Left (100px): PolarAccuracyGauge + ACCURACY label + SeverityMixStrip + "severity mix"
 * - Right (flex): name+status-chip row, 3 sub-bars (reliability/unique/impact),
 *                 AreaSparkline+delta, signals+timeAgo footer
 *
 * Per-agent identity color (agentColor(id)) drives gauge stroke, all 3 sub-bars,
 * and the sparkline. Card chrome (border, bg, hover) stays neutral.
 * Status chip semantic: healthy / needs skills with --ok / --warn dots.
 */

import type React from 'react';
import type { AgentData } from '@/lib/types';
import type { FleetTrendPoint } from '@/lib/types';
import type { SeverityCount } from '@/hooks/useSeverityCounts';
import { NeuralAvatar } from './NeuralAvatar';
import { PolarAccuracyGauge } from './PolarAccuracyGauge';
import { SeverityMixStrip } from './SeverityMixStrip';
import { AreaSparkline } from './AreaSparkline';
import { agentColor, timeAgo } from '@/lib/utils';
import { getBenchBadgeKind } from '@/lib/bench';

export interface AgentCardBigProps {
  agent: AgentData;
  severityCounts?: SeverityCount;
  trendPoints?: FleetTrendPoint[];
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

interface StatusChipKind {
  label: 'healthy' | 'needs skills';
  dotColor: string;
  tooltip: string;
}

function statusChipKind(s: AgentData['scores']): StatusChipKind {
  if (s.accuracy >= 0.7 && s.bench?.state === 'none') {
    return {
      label: 'healthy',
      dotColor: 'var(--ok)',
      tooltip: `Accuracy ${Math.round(s.accuracy * 100)}% — above 70% baseline.`,
    };
  }
  return {
    label: 'needs skills',
    dotColor: 'var(--warn)',
    tooltip: s.bench?.state !== 'none'
      ? `Benched (${s.bench?.reason ?? 'auto'})`
      : `Accuracy ${Math.round(s.accuracy * 100)}% — below 70% baseline.`,
  };
}

/** Horizontal metric bar — reliability / unique / impact */
function SubBar({ label, value, color, tooltip }: {
  label: string;
  value: number;
  color: string;
  tooltip: string;
}) {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return (
    <div
      className="grid items-center gap-2"
      style={{ gridTemplateColumns: '56px 1fr 32px' }}
    >
      <span
        className="text-[11px]"
        style={{ color: 'var(--ink-3)', fontFamily: 'Geist, Inter, sans-serif', fontVariant: 'small-caps', letterSpacing: '0.04em' }}
        data-tooltip={tooltip}
      >
        {label}
      </span>
      <div
        className="h-2 overflow-hidden rounded-full"
        style={{ background: 'color-mix(in oklch, var(--ink) 8%, transparent)' }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.round(v * 100)}%`, background: color }}
        />
      </div>
      <span
        className="text-right tabular-nums"
        style={{ fontFamily: 'Geist, Inter, sans-serif', fontSize: 11, color: 'var(--ink-2)' }}
      >
        {pct(v)}
      </span>
    </div>
  );
}

export function AgentCardBig({ agent, severityCounts, trendPoints }: AgentCardBigProps) {
  const s = agent.scores;
  const lastTime = agent.lastTask?.timestamp ? timeAgo(agent.lastTask.timestamp) : '';
  const ac = agentColor(agent.id);
  const status = statusChipKind(s);

  return (
    <a
      href={`/dashboard/agent/${encodeURIComponent(agent.id)}`}
      className="group relative block rounded-lg border border-border p-3 transition-all hover:-translate-y-0.5 hover:border-[color-mix(in_oklch,var(--ink)_30%,transparent)]"
      style={{ background: 'var(--surface-elev)' }}
    >
      {/* Status chip pinned top-right of the entire card */}
      <div style={{ position: 'absolute', top: 10, right: 12, zIndex: 1 }}>
        <span
          className="inline-flex items-center gap-1.5 rounded-sm border border-border/60 px-2 py-0.5"
          style={{
            background: 'color-mix(in oklch, var(--surface) 60%, transparent)',
            color: 'var(--ink-2)',
            fontFamily: 'Geist, Inter, sans-serif',
            fontSize: 11,
            fontVariant: 'small-caps',
            letterSpacing: '0.04em',
          }}
          data-tooltip={status.tooltip}
          data-tooltip-pos="bottom"
        >
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: status.dotColor, flexShrink: 0 }} />
          {status.label}
        </span>
      </div>

      {/* Two-column grid: 100px gauge column + flexible meta column.
          alignItems:stretch lets the left column distribute its content
          vertically so gauge pins top, severity-mix pins bottom — mirrors
          the right column's name-row / bars / sparkline rhythm. */}
      <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 12, alignItems: 'stretch' }}>

        {/* ── Left column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingBottom: 2 }}>
          <PolarAccuracyGauge accuracy={s.accuracy} size={90} color={ac} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: '100%' }}>
            <SeverityMixStrip counts={severityCounts} />
            <span
              style={{
                fontSize: 10,
                color: 'var(--ink-3)',
                fontFamily: 'Geist, Inter, sans-serif',
                fontVariant: 'small-caps',
                letterSpacing: '0.04em',
              }}
            >
              severity mix
            </span>
          </div>
        </div>

        {/* ── Right column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>

          {/* Name row + bench chip — avatar omitted; Fleet/graph already
              carries the per-agent identity visual. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <span
                  className="truncate"
                  style={{
                    fontFamily: 'Geist, Inter, sans-serif',
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--ink)',
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {agent.id}
                </span>
                {(() => {
                  const kind = getBenchBadgeKind(s);
                  if (kind === 'benched') return (
                    <span
                      className="shrink-0 rounded-sm bg-bad/10 px-1 py-0.5 font-mono text-[8px] font-bold text-bad"
                      aria-label={`Benched (${s.bench.reason ?? 'auto'}). Excluded from dispatch until recovery.`}
                      data-tooltip={`Benched (${s.bench.reason ?? 'auto'}). Excluded from dispatch until recovery.`}
                    >
                      BENCHED
                    </span>
                  );
                  if (kind === 'struggling') return (
                    <span
                      className="shrink-0 rounded-sm bg-unverified/10 px-1 py-0.5 font-mono text-[8px] font-bold text-unverified"
                      aria-label="Struggling: consecutive failures tripped the circuit breaker."
                      data-tooltip="Struggling: consecutive failures tripped the circuit breaker."
                    >
                      STRUGGLING
                    </span>
                  );
                  if (kind === 'kept-for-coverage') return (
                    <span
                      className="shrink-0 rounded-sm border border-unverified/40 bg-unverified/10 px-1 py-0.5 font-mono text-[8px] font-bold text-unverified"
                      aria-label={`Would bench (${s.bench.reason ?? 'rule'}), but kept as sole provider of a category.`}
                      data-tooltip={`Would bench (${s.bench.reason ?? 'rule'}), but kept as sole provider of a category.`}
                    >
                      KEPT
                    </span>
                  );
                  return null;
                })()}
              </div>
            </div>
          </div>

          {/* Metric bars */}
          <div
            className="rounded-md border border-border/30 px-2 py-2 space-y-1.5"
            style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)' }}
          >
            <SubBar
              label="unique"
              value={s.uniqueness}
              color={ac}
              tooltip={`Uniqueness ${pct(s.uniqueness)}\nFindings others missed.`}
            />
            <SubBar
              label="impact"
              value={s.impactScore}
              color={ac}
              tooltip={`Impact ${pct(s.impactScore)}\nSeverity-weighted findings.`}
            />
          </div>

          {/* Sparkline + footer — width matches the metric bars above (full row width). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {trendPoints && trendPoints.length > 0 && (
              <div style={{ width: '100%' }}>
                <AreaSparkline points={trendPoints} width={240} height={28} color={ac} />
              </div>
            )}
            <div
              style={{
                fontFamily: 'Geist, Inter, sans-serif',
                fontSize: 11,
                color: 'var(--ink-3)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span className="tabular-nums">{s.signals} signals</span>
              {lastTime && (
                <>
                  <span style={{ opacity: 0.5 }}>·</span>
                  <span>{lastTime}</span>
                </>
              )}
            </div>
          </div>

        </div>
      </div>
    </a>
  );
}
