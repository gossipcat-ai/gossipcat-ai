import type { AgentData } from '@/lib/types';
import { NeuralAvatar } from './NeuralAvatar';
import { timeAgo } from '@/lib/utils';

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
    wt === 'low' ? 'text-disputed' : 'text-foreground';

  const at = accTier(s.accuracy);
  const accBarClass =
    at === 'good' ? 'bg-confirmed' :
    at === 'mid' ? 'bg-unverified' : 'bg-disputed';

  return (
    <a
      href={`/dashboard/agent/${encodeURIComponent(agent.id)}`}
      className="group relative block rounded-xl border border-border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-card/90"
    >
      {/* Flatten pass: the card used to layer gradient + inset highlight line
          + outer shadow + hover ring + per-agent avatar halo blur, which felt
          skeuomorphic and fought the metric bars for attention. Single card
          background + subtle hover lift reads cleaner in the 2x2 hero grid. */}
      <div className="mb-3.5 flex items-center gap-3">
        <div className="relative shrink-0">
          <NeuralAvatar
            agentId={agent.id}
            size={60}
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
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{agent.id}</span>
            {s.circuitOpen && (
              <span
                className="shrink-0 rounded-sm bg-destructive/10 px-1 py-0.5 font-mono text-[8px] font-bold text-destructive"
                data-tooltip="Benched: too many consecutive failures. Deprioritized until new clean signals recover the score."
              >
                BENCHED
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground/60" style={{ fontFamily: "'Inter', sans-serif" }}>
            <span
              className={`rounded-sm border border-border/60 bg-background/60 px-1.5 py-0.5 font-bold tabular-nums ${weightColor}`}
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
      <div className="space-y-2 rounded-lg border border-border/30 bg-background/40 px-3.5 py-3">
        <BarRow
          label="accuracy"
          value={s.accuracy}
          fillClass={accBarClass}
          tooltip={`Accuracy ${pct(s.accuracy)}\nRatio of confirmed findings.\nHigher = more trustworthy.`}
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
  return (
    <div className="grid grid-cols-[60px_1fr_38px] items-center gap-2.5">
      <span
        className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
        data-tooltip={tooltip}
      >
        {label}
      </span>
      <div className="h-2 overflow-hidden rounded-full bg-background/80">
        <div
          className={`h-full rounded-full transition-all ${fillClass}`}
          style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
        />
      </div>
      <span className="text-right font-mono text-[11px] font-bold tabular-nums text-foreground">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}
