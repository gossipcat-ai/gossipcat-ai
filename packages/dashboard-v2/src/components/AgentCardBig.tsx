/**
 * AgentCardBig — Step 6 rewrite (DESIGN.md).
 *
 * Two-column layout:
 * - Left (100px): PolarAccuracyGauge + SeverityMixStrip + "severity mix" label
 * - Right (flex): name+chip row, 3 sub-bars (reliability/unique/impact),
 *                 AreaSparkline+delta, signals+timeAgo footer
 *
 * Gate: no var(--accent) in chart bars. Gauge stroke is status-semantic.
 * Card chrome is neutral — no per-agent color except NeuralAvatar bloom.
 */

import type React from 'react';
import type { AgentData } from '@/lib/types';
import type { FleetTrendPoint } from '@/lib/types';
import type { SeverityCount } from '@/hooks/useSeverityCounts';
import { NeuralAvatar } from './NeuralAvatar';
import { PolarAccuracyGauge } from './PolarAccuracyGauge';
import { SeverityMixStrip } from './SeverityMixStrip';
import { AreaSparkline } from './AreaSparkline';
import { timeAgo } from '@/lib/utils';
import { getBenchBadgeKind } from '@/lib/bench';

export interface AgentCardBigProps {
  agent: AgentData;
  severityCounts?: SeverityCount;
  trendPoints?: FleetTrendPoint[];
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function weightTier(w: number): 'good' | 'mid' | 'low' {
  if (w >= 1.2) return 'good';
  if (w >= 0.8) return 'mid';
  return 'low';
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
        className="font-mono text-[9px]"
        style={{ color: 'var(--ink-3)', fontVariant: 'small-caps', letterSpacing: '0.04em' }}
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

  const wt = weightTier(s.dispatchWeight);
  const weightColor =
    wt === 'good' ? 'var(--ok)' :
    wt === 'low' ? 'var(--bad)' : 'var(--ink-3)';

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
          <PolarAccuracyGauge accuracy={s.accuracy} size={90} />
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
              {/* Weight + provider chip */}
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
                  className="rounded-sm border border-border/60 px-1.5 py-0.5 tabular-nums"
                  style={{
                    background: 'color-mix(in oklch, var(--surface) 60%, transparent)',
                    color: weightColor,
                    fontWeight: 600,
                  }}
                  data-tooltip={`Dispatch weight ${s.dispatchWeight.toFixed(2)}\nScale 0.3 → 2.0`}
                  data-tooltip-pos="bottom"
                >
                  {s.dispatchWeight.toFixed(2)} wt
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
              color="var(--c1)"
              tooltip={`Reliability ${pct(s.taskCompletionRate ?? 0)}\nTask completion rate.`}
            />
            <SubBar
              label="unique"
              value={s.uniqueness}
              color="var(--c2)"
              tooltip={`Uniqueness ${pct(s.uniqueness)}\nFindings others missed.`}
            />
            <SubBar
              label="impact"
              value={s.impactScore}
              color="var(--c3)"
              tooltip={`Impact ${pct(s.impactScore)}\nSeverity-weighted findings.`}
            />
          </div>

          {/* Sparkline + footer */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {trendPoints && trendPoints.length > 0 && (
              <AreaSparkline points={trendPoints} width={80} height={20} />
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
