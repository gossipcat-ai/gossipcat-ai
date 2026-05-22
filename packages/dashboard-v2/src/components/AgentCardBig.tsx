import type React from 'react';
import type { AgentData } from '@/lib/types';
import { NeuralAvatar } from './NeuralAvatar';
import { timeAgo } from '@/lib/utils';
import { getBenchBadgeKind } from '@/lib/bench';

interface AgentCardBigProps {
  agent: AgentData;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function weightTier(w: number): 'good' | 'mid' | 'low' {
  if (w >= 1.2) return 'good';
  if (w >= 0.8) return 'mid';
  return 'low';
}

function accTier(a: number): 'good' | 'mid' | 'low' {
  if (a >= 0.7) return 'good';
  if (a >= 0.4) return 'mid';
  return 'low';
}

export function AgentCardBig({ agent }: AgentCardBigProps) {
  const s = agent.scores;
  const lastTime = agent.lastTask?.timestamp ? timeAgo(agent.lastTask.timestamp) : '';

  const wt = weightTier(s.dispatchWeight);
  const weightColor =
    wt === 'good' ? 'text-confirmed' :
    wt === 'low' ? 'text-disputed' : '';
  const weightColorStyle = wt === 'good' || wt === 'low' ? undefined : { color: 'var(--text)' } as React.CSSProperties;

  const at = accTier(s.accuracy);
  const accBarClass =
    at === 'good' ? 'bg-confirmed' :
    at === 'mid' ? 'bg-unverified' : 'bg-disputed';

  return (
    <a
      href={`/dashboard/agent/${encodeURIComponent(agent.id)}`}
      className="group relative block rounded-lg border border-border p-3 transition-all hover:-translate-y-0.5 hover:border-primary/30"
      style={{ background: 'var(--surface-elev)' }}
    >
      {/* Flatten pass: the card used to layer gradient + inset highlight line
          + outer shadow + hover ring + per-agent avatar halo blur, which felt
          skeuomorphic and fought the metric bars for attention. Single card
          background + subtle hover lift reads cleaner in the 2x2 hero grid. */}
      <div className="mb-2.5 flex items-center gap-2.5">
        <div className="relative shrink-0">
          <NeuralAvatar
            agentId={agent.id}
            size={48}
            animate={agent.online}
            signals={s.signals}
            accuracy={s.accuracy}
            uniqueness={s.uniqueness}
            impact={s.impactScore}
          />
        </div>

        {/* Name + meta — full remaining width */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>{agent.id}</span>
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
                  KEPT FOR COVERAGE
                </span>
              );
              return null;
            })()}
          </div>
          <div className="mt-1 flex items-center gap-2 font-inter text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>
            <span
              className={`rounded-sm border border-border/60 px-1.5 py-0.5 font-bold tabular-nums ${weightColor}`}
              style={{ background: 'color-mix(in oklch, var(--surface) 60%, transparent)', ...weightColorStyle }}
              data-tooltip={`Dispatch weight ${s.dispatchWeight.toFixed(2)}\nScale 0.3 → 2.0`}
              data-tooltip-pos="bottom"
            >
              {s.dispatchWeight.toFixed(2)} wt
            </span>
            <span className="truncate">{s.signals} signals{lastTime ? ` · ${lastTime}` : ''}</span>
          </div>
        </div>
      </div>

      {/* Metric bars — neutral inset panel without the extra shadow layer */}
      <div className="space-y-1.5 rounded-lg border border-border/30 px-2.5 py-2" style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)' }}>
        <BarRow
          label="accuracy"
          value={s.accuracy}
          fillClass={accBarClass}
          tooltip={`Accuracy ${pct(s.accuracy)}\nRatio of confirmed findings.\nHigher = more trustworthy.`}
        />
        <BarRow
          label="reliability"
          value={s.taskCompletionRate ?? 0}
          fillClass="bg-chart"
          tooltip={`Reliability ${pct(s.taskCompletionRate ?? 0)}\nTask completion rate — fraction of dispatched tasks that finished without pipeline error or timeout.`}
        />
        <BarRow
          label="unique"
          value={s.uniqueness}
          fillClass="bg-unique"
          tooltip={`Uniqueness ${pct(s.uniqueness)}\nFindings others missed.\nHigher = this agent sees what peers don't.`}
        />
        <BarRow
          label="impact"
          value={s.impactScore}
          fillClass="bg-[var(--color-impact)]"
          tooltip={`Impact ${pct(s.impactScore)}\nSeverity-weighted findings.\nCritical and high findings count more.`}
        />
      </div>
    </a>
  );
}

interface BarRowProps {
  label: string;
  value: number;
  fillClass: string;
  tooltip: string;
}

function BarRow({ label, value, fillClass, tooltip }: BarRowProps) {
  const v = Number.isFinite(value) ? value : 0;
  return (
    <div className="grid grid-cols-[72px_1fr_38px] items-center gap-2.5">
      <span
        className="font-mono text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
        data-tooltip={tooltip}
      >
        {label}
      </span>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: 'color-mix(in oklch, var(--surface) 80%, transparent)' }}>
        <div
          className={`h-full rounded-full transition-all ${fillClass}`}
          style={{ width: `${Math.max(0, Math.min(100, v * 100))}%` }}
        />
      </div>
      <span className="text-right font-mono text-[11px] font-bold tabular-nums" style={{ color: 'var(--text)' }}>
        {Math.round(v * 100)}%
      </span>
    </div>
  );
}
