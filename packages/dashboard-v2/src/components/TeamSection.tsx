import { useState } from 'react';
import type { AgentData } from '@/lib/types';
import { AgentRow } from './AgentRow';
import { AgentDetailModal } from './AgentDetailModal';

interface TeamSectionProps {
  agents: AgentData[];
}

export function TeamSection({ agents }: TeamSectionProps) {
  const [selected, setSelected] = useState<AgentData | null>(null);

  const sorted = [...agents].sort((a, b) =>
    (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0)
  );
  const visible = sorted.slice(0, 5);
  const remaining = sorted.length - 5;

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Team <span className="text-primary">{agents.length} agents</span>
        </h2>
        {remaining > 0 && (
          <a
            href="#/team"
            className="font-mono text-xs text-muted-foreground transition hover:text-primary"
          >
            view all →
          </a>
        )}
      </div>
      <div className="space-y-2">
        {visible.map((agent) => (
          <AgentRow key={agent.id} agent={agent} onClick={() => setSelected(agent)} />
        ))}
      </div>
      {selected && (
        <AgentDetailModal agent={selected} open={!!selected} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
