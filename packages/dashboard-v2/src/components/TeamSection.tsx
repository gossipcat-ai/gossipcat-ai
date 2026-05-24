import type { AgentData } from '@/lib/types';
import { AgentRow } from './AgentRow';

interface TeamSectionProps {
  agents: AgentData[];
}

export function TeamSection({ agents }: TeamSectionProps) {
  const sorted = [...agents].sort((a, b) => {
    const aTime = a.lastTask?.timestamp ? new Date(a.lastTask.timestamp).getTime() : 0;
    const bTime = b.lastTask?.timestamp ? new Date(b.lastTask.timestamp).getTime() : 0;
    return bTime - aTime;
  });
  const visible = sorted.slice(0, 5);
  const hasMore = sorted.length > 5;

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="h-section">
          Team <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{agents.length} agents</span>
        </h2>
        {hasMore && (
          <a
            href="/dashboard/team"
            className="font-mono text-xs transition hover:[color:var(--accent)]"
            style={{ color: 'var(--text-dim)' }}
          >
            view all →
          </a>
        )}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {visible.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}
