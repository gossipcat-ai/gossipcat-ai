import type { AgentData } from '@/lib/types';
import { AgentCardBig } from './AgentCardBig';

interface TeamHeroProps {
  agents: AgentData[];
}

export function TeamHero({ agents }: TeamHeroProps) {
  // Sort by most recent dispatch first (lastTask.timestamp desc), with signal count as tie-break
  // so agents with no tasks sink to the bottom deterministically.
  const sorted = [...agents].sort((a, b) => {
    const aTs = a.lastTask?.timestamp ?? '';
    const bTs = b.lastTask?.timestamp ?? '';
    if (aTs !== bTs) return bTs.localeCompare(aTs);
    const aSig = a.scores?.signals || 0;
    const bSig = b.scores?.signals || 0;
    if (aSig !== bSig) return bSig - aSig;
    return a.id.localeCompare(b.id);
  });
  const visible = sorted.slice(0, 4);
  const hasMore = sorted.length > 4;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
          Team <span className="text-primary">{agents.length}</span>
        </h2>
        {hasMore && (
          <a href="/dashboard/team" className="font-mono text-xs text-muted-foreground transition hover:text-primary">
            view all
          </a>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {visible.map((agent) => (
          <AgentCardBig key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}
