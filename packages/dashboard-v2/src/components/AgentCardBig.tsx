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
        className="text-[9px]"
        style={{ color: 'var(--ink-3)', fontFamily: 'Geist, Inter, sans-serif', fontVariant: 'small-caps', letterSpacing: '0.04em' }}
        data-tooltip={tooltip}
      >
        {label}
      </span>
      <div
        className="h-1.5 overflow-hidden rounded-full"
        style={{ background: 'color-mix(in oklch, var(--ink) 8%, transparent)' }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.round(v * 100)}%`, background: color }}
        />
      </div>
      <span
        className="text-right tabular-nums"
        style={{ fontFamily: 'Geist, Inter, sans-serif', fontSize: 10, color: 'var(--ink-3)' }}
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
      {/* Two-column grid: 100px gauge column + flexible meta column */}
      <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 12, alignItems: 'start' }}>

        {/* ── Left column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <PolarAccuracyGauge accuracy={s.accuracy} size={90} color={ac} />
          <SeverityMixStrip counts={severityCounts} />
          <span
            style={{
              fontSize: 9,
              color: 'var(--ink-3)',
              fontFamily: 'Geist, Inter, sans-serif',
              fontVariant: 'small-caps',
              letterSpacing: '0.04em',
            }}
          >
            severity mix
          </span>
        </div>

        {/* ── Right column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>

          {/* Name row + avatar + bench chip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flexShrink: 0 }}>
              <NeuralAvatar
                agentId={agent.id}
                size={36}
                animate={agent.online}
                signals={s.signals}
                accuracy={s.accuracy}
                uniqueness={s.uniqueness}
                impact={s.impactScore}
              />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <span
                  className="truncate"
                  style={{
                    fontFamily: 'Geist, Inter, sans-serif',
                    fontSize: 12,
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
                      className="shrink-0 rounded-sm bg-destructive/10 px-1 py-0.5 font-mono text-[8px] font-bold text-destructive"
                      data-tooltip={`Benched (${s.bench.reason ?? 'auto'}). Excluded from dispatch until recovery.`}
                    >
                      BENCHED
                    </span>
                  );
                  if (kind === 'struggling') return (
                    <span
                      className="shrink-0 rounded-sm bg-unverified/10 px-1 py-0.5 font-mono text-[8px] font-bold text-unverified"
                      data-tooltip="Struggling: consecutive failures tripped the circuit breaker."
                    >
                      STRUGGLING
                    </span>
                  );
                  if (kind === 'kept-for-coverage') return (
                    <span
                      className="shrink-0 rounded-sm border border-unverified/40 bg-unverified/10 px-1 py-0.5 font-mono text-[8px] font-bold text-unverified"
                      data-tooltip={`Would bench (${s.bench.reason ?? 'rule'}), but kept as sole provider of a category.`}
                    >
                      KEPT
                    </span>
                  );
                  return null;
                })()}
              </div>
              {/* Status chip — healthy / needs skills */}
              <div
                style={{
                  marginTop: 2,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontFamily: 'Geist, Inter, sans-serif',
                  fontSize: 10,
                  color: 'var(--ink-3)',
                }}
              >
                <span
                  className="inline-flex items-center gap-1 rounded-sm border border-border/60 px-1.5 py-0.5"
                  style={{
                    background: 'color-mix(in oklch, var(--surface) 60%, transparent)',
                    color: 'var(--ink-3)',
                    fontVariant: 'small-caps',
                    letterSpacing: '0.04em',
                  }}
                  data-tooltip={status.tooltip}
                  data-tooltip-pos="bottom"
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: status.dotColor,
                      flexShrink: 0,
                    }}
                  />
                  {status.label}
                </span>
              </div>
            </div>
          </div>

          {/* Metric bars */}
          <div
            className="rounded-md border border-border/30 px-2 py-2 space-y-1.5"
            style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)' }}
          >
            <SubBar
              label="reliability"
              value={s.taskCompletionRate ?? 0}
              color={ac}
              tooltip={`Reliability ${pct(s.taskCompletionRate ?? 0)}\nTask completion rate.`}
            />
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
                fontSize: 10,
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
