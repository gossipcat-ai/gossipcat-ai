import type { AgentData, FleetTrendPoint } from '@/lib/types';
import type { SeverityCountMap } from '@/hooks/useSeverityCounts';
import { AgentCardBig } from './AgentCardBig';

interface TeamHeroProps {
  agents: AgentData[];
  /** Optional — when set, the matching card gets an accent ring so it
   *  echoes the AgentNetworkGraph selection. Phase 1b PR3 wires this. */
  highlightedAgentId?: string | null;
  /** Step 6 — per-agent severity distribution from useSeverityCounts. */
  severityMap?: SeverityCountMap;
  /** Step 6 — per-agent 7d trend points for AreaSparkline. */
  trendByAgent?: Map<string, FleetTrendPoint[]>;
}

export function TeamHero({ agents, highlightedAgentId, severityMap, trendByAgent }: TeamHeroProps) {
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
        <h2 className="h-section">
          Team <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{agents.length}</span>
        </h2>
        {hasMore && (
          <a href="/dashboard/team" className="text-xs transition hover:[color:var(--accent)]" style={{ color: 'var(--text-dim)' }}>
            view all
          </a>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {visible.map((agent) => {
          const isHighlighted = agent.id === highlightedAgentId;
          return (
            <div
              key={agent.id}
              style={{
                borderRadius: '0.5rem',
                boxShadow: isHighlighted ? '0 0 0 2px var(--border-strong)' : undefined,
                transition: 'box-shadow 200ms cubic-bezier(0.4,0,0.2,1)',
              }}
            >
              <AgentCardBig
                agent={agent}
                severityCounts={severityMap?.get(agent.id)}
                trendPoints={trendByAgent?.get(agent.id)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
