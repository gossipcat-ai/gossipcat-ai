import { useMemo, useState } from 'react';
import { SystemPulse } from '@/components/SystemPulse';
import { ActivityWaterfall } from '@/components/ActivityWaterfall';
import { ActiveTasksBanner } from '@/components/ActiveTasksBanner';
import { TeamHero } from '@/components/TeamHero';
import { TasksSection } from '@/components/TasksSection';
import { RecentSignalsPeek } from '@/components/RecentSignalsPeek';
import { SkillVerdictsSnapshot } from '@/components/SkillVerdictsSnapshot';
import { SkillGraduationGrid } from '@/components/SkillGraduationGrid';
import { AgentNetworkGraph } from '@/components/AgentNetworkGraph';
import { GraphRail } from '@/components/GraphRail';
import { NarrativeStripe } from '@/components/NarrativeStripe';
import { TemporalScrubber } from '@/components/TemporalScrubber';
import { usePeerRelationships } from '@/hooks/usePeerRelationships';
import { useSeverityCounts } from '@/hooks/useSeverityCounts';
import { useUrlAgentParam } from '@/hooks/useUrlAgentParam';
import { useUrlRangeParam } from '@/hooks/useUrlRangeParam';
import { useGlobalAgentKeys } from '@/hooks/useGlobalAgentKeys';
import { isGraphHidden } from '@/lib/feature-flags';
import { href } from '@/lib/router';
import type { OverviewData, AgentData, TasksData, ConsensusData, ConsensusReportsData, FleetTrendResponse, FleetTrendPoint, SignalActivityResponse } from '@/lib/types';
import type { SkillsApiResponse } from '@gossip/types';

interface OverviewPageProps {
  overview: OverviewData;
  agents: AgentData[] | null;
  tasks: TasksData | null;
  /** Optional — consumed by the graph layer to derive peer relationships. */
  consensus?: ConsensusData | null;
  /** Optional — Step 6: supplies severity counts for AgentCardBig. */
  consensusReports?: ConsensusReportsData | null;
  /** Optional — Step 6: supplies 7d sparkline data for AgentCardBig. */
  fleetTrend?: FleetTrendResponse | null;
  /** Optional — 24h per-agent signal histogram for the ActivityWaterfall heatmap. */
  signalActivity?: SignalActivityResponse | null;
  /** Optional — Step 9.5: per-skill post-bind effectiveness curves. */
  skills?: SkillsApiResponse | null;
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
  consensusReports,
  fleetTrend,
  signalActivity,
  skills,
  activeTaskCount,
  setActiveTaskCount,
}: OverviewPageProps) {
  const actionable = overview.actionableFindings;
  const hideGraph = isGraphHidden();
  const peerRelationships = usePeerRelationships(consensus?.runs);

  // Step 6 — client-side severity counts for AgentCardBig gauge/strip
  const severityMap = useSeverityCounts(consensusReports?.reports);

  // Step 6 — per-agent trend points for AreaSparkline
  const trendByAgent = useMemo((): Map<string, FleetTrendPoint[]> => {
    const m = new Map<string, FleetTrendPoint[]>();
    if (fleetTrend) {
      for (const p of fleetTrend.points) {
        const arr = m.get(p.agentId) ?? [];
        arr.push(p);
        m.set(p.agentId, arr);
      }
      for (const arr of m.values()) {
        arr.sort((a, b) => a.day.localeCompare(b.day));
      }
    }
    return m;
  }, [fleetTrend]);
  // Phase 1b PR4 — selection state moved to ?agent= URL param for deep-linking.
  const [selectedAgentId, setSelectedAgentId] = useUrlAgentParam();
  // Phase 1b PR5 — ?range= for TemporalScrubber + global ⏎/G shortcuts.
  const [range, setRange] = useUrlRangeParam();
  useGlobalAgentKeys(selectedAgentId);
  const selectedAgent = agents && selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId) ?? null
    : null;

  // Fix 3 — local toggle state; synced with ?graph= URL param via replaceState
  const [graphVisible, setGraphVisible] = useState(!hideGraph);
  function toggleGraph() {
    const next = !graphVisible;
    setGraphVisible(next);
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.delete('graph');
    } else {
      url.searchParams.set('graph', '0');
    }
    window.history.replaceState(null, '', url.toString());
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Page header — Fix 2: moved above the graph block */}
      <header>
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="h-route h-route--lg">Overview</h1>
          <div className="flex items-baseline gap-4">
            {actionable > 0 && (
              <a
                href={href('/signals?signal=disagreement&signal=hallucination_caught&signal=new_finding')}
                className="font-mono text-[11px] transition hover:underline"
                style={{ color: 'var(--warn)' }}
                data-tooltip="Findings open for operator review"
              >
                {actionable} actionable →
              </a>
            )}
            {/* Fix 3 — graph visibility toggle */}
            {agents && (
              <button
                type="button"
                onClick={toggleGraph}
                className="font-mono text-[10px] transition hover:underline"
                style={{ color: 'var(--text-dim)' }}
              >
                {graphVisible ? '[hide graph]' : '[show graph]'}
              </button>
            )}
          </div>
        </div>
        <p className="mt-1 font-mono text-[13px]" style={{ color: 'var(--text-dim)' }}>
          What your agents are doing right now.
        </p>
      </header>

      {/* Phase 1b PRs 3-6 — Graph + Rail + NarrativeStripe + TemporalScrubber.
          Shown by default; ?graph=0 opts out (escape hatch to the legacy
          calm-widgets-only layout below). Fix 3: now also togglable via header button. */}
      {graphVisible && agents && (
        <div className="space-y-3">
          <NarrativeStripe />
          <div className="flex items-stretch gap-3">
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

      {/* Hero strip — calm SystemPulse */}
      <SystemPulse
        overview={overview}
        activeTasks={activeTaskCount}
        mode="calm"
      />

      {/* Live tasks (self-hides when nothing is running) — Fix 4: moved before waterfall */}
      <ActiveTasksBanner onCountChange={setActiveTaskCount} />

      {/* DESIGN.md Step 5 — 24h per-agent activity waterfall. Replaces the
          single-row fleet-wide hourly bars with a heatmap matrix that shows
          WHO was active WHEN. */}
      {agents && (
        <ActivityWaterfall
          agents={agents}
          activity={signalActivity}
        />
      )}

      {/* Last 5 signals — Fix 4: moved before tasks */}
      <RecentSignalsPeek />

      {/* Recent dispatches — limit 3 (vs dense view's 5) */}
      {tasks && <TasksSection tasks={tasks} limit={3} />}

      {/* Top-4 agents — Fix 4: moved below live feeds + tasks */}
      {agents && (
        <TeamHero
          agents={agents}
          highlightedAgentId={graphVisible ? selectedAgentId : null}
          severityMap={severityMap}
          trendByAgent={trendByAgent}
        />
      )}

      {/* DESIGN.md Step 9 — Skill graduation. Snapshot is the bar-chart
          summary; grid is the per-skill breakdown across all live bindings.
          Both render from already-fetched overview + agents data. */}
      <SkillVerdictsSnapshot overview={overview} />
      <SkillGraduationGrid skills={skills ?? null} />
    </div>
  );
}
