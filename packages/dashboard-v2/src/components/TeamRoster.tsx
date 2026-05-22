import type React from 'react';
import type { AgentData } from '@/lib/types';
import { agentColor, timeAgo } from '@/lib/utils';
import { getBenchBadgeKind } from '@/lib/bench';

interface TeamRosterProps {
  agents: AgentData[];
}

export function TeamRoster({ agents }: TeamRosterProps) {
  const sorted = [...agents].sort((a, b) =>
    (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0)
  );

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--text)' }}>
          Team <span style={{ color: 'var(--accent)' }}>{agents.length}</span>
        </h2>
        <a href="/dashboard/team" className="font-mono text-xs transition" style={{ color: 'var(--text-dim)' }}>
          view all
        </a>
      </div>
      <div className="rounded-md border border-border/40" style={{ background: 'color-mix(in oklch, var(--surface-elev) 80%, transparent)' }}>
        {sorted.map((agent, i) => {
          const s = agent.scores;
          const color = agentColor(agent.id);
          const lastTime = agent.lastTask?.timestamp ? timeAgo(agent.lastTask.timestamp) : '';
          const weightColor = s.dispatchWeight >= 1.2 ? 'text-confirmed' : '';
          const weightColorStyle = s.dispatchWeight >= 1.2 ? undefined
            : s.dispatchWeight >= 0.8 ? { color: 'var(--text)' } as React.CSSProperties
            : { color: 'var(--text-dim)' } as React.CSSProperties;
          const metricBars = [
            { label: 'Acc', value: s.accuracy, fill: s.accuracy >= 0.7 ? 'bg-confirmed' : s.accuracy >= 0.4 ? 'bg-unverified' : 'bg-disputed' },
            { label: 'Rel', value: s.taskCompletionRate ?? 0, fill: 'bg-chart', tooltip: 'Reliability — fraction of dispatched tasks that finished without pipeline error or timeout' },
            { label: 'Unq', value: s.uniqueness, fill: 'bg-unique' },
            { label: 'Imp', value: s.impactScore, fill: 'bg-[var(--color-impact)]' },
          ];

          return (
            <a
              key={agent.id}
              href={`/dashboard/agent/${encodeURIComponent(agent.id)}`}
              className={`flex items-stretch border-l-[3px] transition hover:bg-accent/50 ${
                i > 0 ? 'border-t border-border/20' : ''
              }`}
              style={{ borderLeftColor: color }}
            >
              <div className="min-w-0 flex-1 px-3 py-2">
                {/* Line 1: name + circuit badge + weight + accuracy % */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-xs font-semibold" style={{ color: 'var(--text)' }}>{agent.id}</span>
                    {(() => {
                      const kind = getBenchBadgeKind(s);
                      if (kind === 'benched') return (
                        <span className="shrink-0 rounded-sm bg-destructive/10 px-1 py-0.5 font-mono text-[8px] font-bold text-destructive">
                          BENCHED
                        </span>
                      );
                      if (kind === 'struggling') return (
                        <span className="shrink-0 rounded-sm bg-unverified/10 px-1 py-0.5 font-mono text-[8px] font-bold text-unverified">
                          STRUGGLING
                        </span>
                      );
                      if (kind === 'kept-for-coverage') return (
                        <span className="shrink-0 rounded-sm border border-unverified/40 px-1 py-0.5 font-mono text-[8px] font-bold text-unverified">
                          KEPT
                        </span>
                      );
                      return null;
                    })()}
                  </div>
                  <div className="flex shrink-0 items-baseline gap-1.5">
                    <span className={`font-mono text-sm font-bold tabular-nums leading-none ${weightColor}`} style={weightColorStyle}>
                      {s.dispatchWeight.toFixed(1)}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                      {Math.round(s.accuracy * 100)}%
                    </span>
                  </div>
                </div>

                {/* Line 2: 4-metric bars + last active */}
                <div className="mt-1.5 flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    {metricBars.map(m => (
                      <div key={m.label} className="flex items-center gap-2 text-[9px]">
                        <span className="w-6 uppercase" style={{ color: 'var(--text-dim)' }} data-tooltip={m.tooltip}>{m.label}</span>
                        <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: 'color-mix(in oklch, var(--surface) 60%, transparent)' }}>
                          <div className={`h-full ${m.fill}`} style={{ width: `${m.value * 100}%` }} />
                        </div>
                        <span className="w-8 text-right tabular-nums" style={{ color: 'var(--text)' }}>{Math.round(m.value * 100)}%</span>
                      </div>
                    ))}
                  </div>
                  {lastTime && (
                    <span className="shrink-0 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>{lastTime}</span>
                  )}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}
