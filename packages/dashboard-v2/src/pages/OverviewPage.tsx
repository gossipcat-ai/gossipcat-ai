import { SystemPulse } from '@/components/SystemPulse';
import { ActiveTasksBanner } from '@/components/ActiveTasksBanner';
import { TeamHero } from '@/components/TeamHero';
import { TasksSection } from '@/components/TasksSection';
import { RecentSignalsPeek } from '@/components/RecentSignalsPeek';
import { AgentNetworkGraph } from '@/components/AgentNetworkGraph';
import { GraphRail } from '@/components/GraphRail';
import { NarrativeStripe } from '@/components/NarrativeStripe';
import { TemporalScrubber } from '@/components/TemporalScrubber';
import { usePeerRelationships } from '@/hooks/usePeerRelationships';
import { useUrlAgentParam } from '@/hooks/useUrlAgentParam';
import { useUrlRangeParam } from '@/hooks/useUrlRangeParam';
import { useGlobalAgentKeys } from '@/hooks/useGlobalAgentKeys';
import { isGraphHidden } from '@/lib/feature-flags';
import { href } from '@/lib/router';
import type { OverviewData, AgentData, TasksData, ConsensusData } from '@/lib/types';

interface OverviewPageProps {
  overview: OverviewData;
  agents: AgentData[] | null;
  tasks: TasksData | null;
  /** Optional — consumed by the graph layer to derive peer relationships. */
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
  const hideGraph = isGraphHidden();
  const peerRelationships = usePeerRelationships(consensus?.runs);
  // Phase 1b PR4 — selection state moved to ?agent= URL param for deep-linking.
  const [selectedAgentId, setSelectedAgentId] = useUrlAgentParam();
  // Phase 1b PR5 — ?range= for TemporalScrubber + global ⏎/G shortcuts.
  const [range, setRange] = useUrlRangeParam();
  useGlobalAgentKeys(selectedAgentId);
  const selectedAgent = agents && selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId) ?? null
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Phase 1b PRs 3-6 — Graph + Rail + NarrativeStripe + TemporalScrubber.
          Shown by default; ?graph=0 opts out (escape hatch to the legacy
          calm-widgets-only layout below). */}
      {!hideGraph && agents && (
        <div className="space-y-3">
          <NarrativeStripe />
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <AgentNetworkGraph
                agents={agents}
                peerRelationships={peerRelationships}
                selectedAgentId={selectedAgentId}
                onSelectAgent={setSelectedAgentId}
              />
            </div>
            <GraphRail
              selectedAgent={selectedAgent}
              agents={agents}
              peerRelationships={peerRelationships}
            />
          </div>
          {consensus && (
            <TemporalScrubber runs={consensus.runs} range={range} onRangeChange={setRange} />
          )}
        </div>
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

      {/* Top-4 agents — echoes the AgentNetworkGraph selection when the graph is on */}
      {agents && <TeamHero agents={agents} highlightedAgentId={!hideGraph ? selectedAgentId : null} />}

      {/* Recent dispatches — limit 3 (vs dense view's 5) */}
      {tasks && <TasksSection tasks={tasks} limit={3} />}

      {/* Last 5 signals */}
      <RecentSignalsPeek />
    </div>
  );
}
