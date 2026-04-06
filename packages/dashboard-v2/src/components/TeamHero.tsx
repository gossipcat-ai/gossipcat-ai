import type { AgentData } from '@/lib/types';
import { AgentCardBig } from './AgentCardBig';

interface TeamHeroProps {
  agents: AgentData[];
}

export function TeamHero({ agents }: TeamHeroProps) {
  const sorted = [...agents].sort((a, b) => (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0));
  const visible = sorted.slice(0, 6);
  const hasMore = sorted.length > 6;

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
          Team <span className="text-primary">{agents.length}</span>
        </h2>
        {hasMore && (
          <a href="/dashboard/team" className="font-mono text-xs text-muted-foreground transition hover:text-primary">
            view all
          </a>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visible.map((agent) => (
          <AgentCardBig key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}
