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
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Team <span className="text-primary">{agents.length}</span>
        </h2>
        <a href="/dashboard/team" className="font-mono text-xs text-muted-foreground transition hover:text-primary">
          view all
        </a>
      </div>
      <div className="rounded-md border border-border/40 bg-card/80">
        {sorted.map((agent, i) => {
          const s = agent.scores;
          const color = agentColor(agent.id);
          const lastTime = agent.lastTask?.timestamp ? timeAgo(agent.lastTask.timestamp) : '';
          const weightColor =
            s.dispatchWeight >= 1.2 ? 'text-confirmed' :
            s.dispatchWeight >= 0.8 ? 'text-foreground' : 'text-muted-foreground';
          const barColor =
            s.accuracy >= 0.7 ? 'bg-confirmed' :
            s.accuracy >= 0.4 ? 'bg-unverified' : 'bg-disputed';

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
                    <span className="truncate font-mono text-xs font-semibold text-foreground">{agent.id}</span>
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
                    <span className={`font-mono text-sm font-bold tabular-nums leading-none ${weightColor}`}>
                      {s.dispatchWeight.toFixed(1)}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {Math.round(s.accuracy * 100)}%
                    </span>
                  </div>
                </div>

                {/* Line 2: accuracy bar + last active */}
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/30">
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${s.accuracy * 100}%` }}
                    />
                  </div>
                  {lastTime && (
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/40">{lastTime}</span>
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
