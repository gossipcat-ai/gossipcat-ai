import { useState } from 'react';
import type { AgentData } from '@/lib/types';
import { AgentRow } from './AgentRow';
import { AgentDetailModal } from './AgentDetailModal';

interface TeamSectionProps {
  agents: AgentData[];
}

export function TeamSection({ agents }: TeamSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<AgentData | null>(null);

  const sorted = [...agents].sort((a, b) =>
    (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0)
  );
  const visible = expanded ? sorted : sorted.slice(0, 5);
  const remaining = sorted.length - 5;

  return (
    <section>
      <h2 className="mb-4 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
        Team <span className="text-primary">{agents.length} agents</span>
      </h2>
      <div className="space-y-2">
        {visible.map((agent) => (
          <AgentRow key={agent.id} agent={agent} onClick={() => setSelected(agent)} />
        ))}
      </div>
      {remaining > 0 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-3 w-full rounded-md border border-dashed border-border py-2 font-mono text-xs text-muted-foreground transition hover:border-primary hover:text-primary"
        >
          see team ({remaining} more)
        </button>
      )}
      {selected && (
        <AgentDetailModal agent={selected} open={!!selected} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
