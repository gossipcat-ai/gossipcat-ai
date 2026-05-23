import { useState } from 'react';
import { SystemPulse } from '@/components/SystemPulse';
import { ActiveTasksBanner } from '@/components/ActiveTasksBanner';
import { TeamHero } from '@/components/TeamHero';
import { TasksSection } from '@/components/TasksSection';
import { RecentSignalsPeek } from '@/components/RecentSignalsPeek';
import { AgentNetworkGraph } from '@/components/AgentNetworkGraph';
import { usePeerRelationships } from '@/hooks/usePeerRelationships';
import { isGraphBeta } from '@/lib/feature-flags';
import { href } from '@/lib/router';
import type { OverviewData, AgentData, TasksData, ConsensusData } from '@/lib/types';

interface OverviewPageProps {
  overview: OverviewData;
  agents: AgentData[] | null;
  tasks: TasksData | null;
  /** Optional — only consumed by the ?graph=1 beta to derive peer relationships. */
  consensus?: ConsensusData | null;
  activeTaskCount: number;
  setActiveTaskCount: (n: number) => void;
}

/**
 * Calm landing page (Variant A from consensus df14d789-6b714276) at `/` and
 * `/overview`. Composes 6 widgets in a narrow readable column. The previous
 * `?expert=1` dense view was removed in Phase 1a — this is the single Overview.
 *
 * Spec: docs/specs/2026-05-04-overview-route-design.md (gitignored — refer by path).
 */
export function OverviewPage({
  overview,
  agents,
  tasks,
  consensus,
  activeTaskCount,
  setActiveTaskCount,
}: OverviewPageProps) {
  const actionable = overview.actionableFindings;
  const showGraph = isGraphBeta();
  const peerRelationships = usePeerRelationships(consensus?.runs);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Phase 1b PR3 — AgentNetworkGraph behind ?graph=1 flag, ABOVE existing widgets. */}
      {showGraph && agents && (
        <AgentNetworkGraph
          agents={agents}
          peerRelationships={peerRelationships}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
        />
      )}
      {/* Page header */}
      <header>
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-mono text-4xl font-bold tracking-tight" style={{ color: 'var(--text)' }}>
            Overview
          </h1>
          {actionable > 0 && (
            <a
              href={href('/signals?signal=disagreement&signal=hallucination_caught&signal=new_finding')}
              className="font-mono text-[11px] text-orange-400 transition hover:underline"
              data-tooltip="Findings open for operator review"
            >
              {actionable} actionable →
            </a>
          )}
        </div>
        <p className="mt-1 font-mono text-[13px]" style={{ color: 'var(--text-dim)' }}>
          What your agents are doing right now.
        </p>
      </header>

      {/* Hero strip — calm SystemPulse */}
      <SystemPulse
        overview={overview}
        activeTasks={activeTaskCount}
        mode="calm"
      />

      {/* Actionable stat row — present in calm mode when actionable > 0 so the
          attention hook isn't only a small header-right link. */}
      {actionable > 0 && (
        <a
          href={href('/signals?signal=disagreement&signal=hallucination_caught&signal=new_finding')}
          className="inline-flex items-center gap-1.5 font-mono text-[12px] transition hover:[color:var(--text)]"
          style={{ color: 'var(--text-dim)' }}
        >
          <span>◆</span>
          <span className="font-bold text-unverified">{actionable}</span>
          <span>actionable signals →</span>
        </a>
      )}

      {/* Live tasks (self-hides when nothing is running) */}
      <ActiveTasksBanner onCountChange={setActiveTaskCount} />

      {/* Top-4 agents */}
      {agents && <TeamHero agents={agents} />}

      {/* Recent dispatches — limit 3 (vs dense view's 5) */}
      {tasks && <TasksSection tasks={tasks} limit={3} />}

      {/* Last 5 signals */}
      <RecentSignalsPeek />
    </div>
  );
}
