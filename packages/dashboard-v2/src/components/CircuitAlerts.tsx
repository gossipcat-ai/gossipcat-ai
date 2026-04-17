import type { AgentData } from '@/lib/types';
import { timeAgo } from '@/lib/utils';
import { needsAttention } from '@/lib/bench';

interface CircuitAlertsProps {
  agents: AgentData[];
}

type Reason =
  | { label: 'benched (chronic)'; cls: string }
  | { label: 'benched (burst)'; cls: string }
  | { label: string; cls: string };

function describe(agent: AgentData): Reason {
  const s = agent.scores;
  if (s.bench?.state === 'benched') {
    if (s.bench.reason === 'chronic-low-accuracy') {
      return { label: 'benched (chronic)', cls: 'bg-destructive/15 text-destructive' };
    }
    if (s.bench.reason === 'burst-hallucination') {
      return { label: 'benched (burst)', cls: 'bg-destructive/15 text-destructive' };
    }
    return { label: 'benched', cls: 'bg-destructive/15 text-destructive' };
  }
  if (s.bench?.state === 'kept-for-coverage') {
    return { label: 'kept for coverage', cls: 'border border-unverified/40 text-unverified' };
  }
  if (s.circuitOpen) {
    return { label: `struggling (${s.consecutiveFailures} fails)`, cls: 'bg-unverified/15 text-unverified' };
  }
  return { label: '', cls: '' };
}

export function CircuitAlerts({ agents }: CircuitAlertsProps) {
  const attention = agents.filter(needsAttention);
  if (attention.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-destructive/[0.04] px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-destructive/15 font-mono text-[11px] font-bold text-destructive">
            !
          </span>
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-destructive">
            Agents Needing Attention
          </span>
        </div>
        <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 font-mono text-xs font-bold text-destructive">
          {attention.length}
        </span>
      </div>
      <div>
        {attention.map((agent, i) => {
          const lastTime = agent.lastTask?.timestamp ? timeAgo(agent.lastTask.timestamp) : '';
          const r = describe(agent);
          const isBenched = agent.scores.bench?.state === 'benched';
          return (
            <a
              key={agent.id}
              href={`/dashboard/agent/${encodeURIComponent(agent.id)}`}
              className={`block px-3.5 py-3 transition hover:bg-destructive/[0.03] ${
                i > 0 ? 'border-t border-border/40' : ''
              }`}
            >
              <div className="mb-1 flex items-center gap-2.5">
                <span className={`h-1.5 w-1.5 rounded-full ${isBenched ? 'bg-destructive shadow-[0_0_6px_rgba(248,113,113,0.6)]' : 'bg-unverified'}`} />
                <span className="text-sm font-semibold text-foreground">{agent.id}</span>
                {r.label && (
                  <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase ${r.cls}`}>
                    {r.label}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between pl-4 font-mono text-[10px] text-muted-foreground">
                <span>{agent.scores.consecutiveFailures} consecutive fails</span>
                {lastTime && <span className="text-muted-foreground/50">{lastTime}</span>}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
