import { SystemPulse } from '@/components/SystemPulse';
import { ActiveTasksBanner } from '@/components/ActiveTasksBanner';
import { TeamHero } from '@/components/TeamHero';
import { TasksSection } from '@/components/TasksSection';
import { RecentSignalsPeek } from '@/components/RecentSignalsPeek';
import { href } from '@/lib/router';
import type { OverviewData, AgentData, TasksData } from '@/lib/types';

interface OverviewPageProps {
  overview: OverviewData;
  agents: AgentData[] | null;
  tasks: TasksData | null;
  activeTaskCount: number;
  setActiveTaskCount: (n: number) => void;
}

/**
 * Calm landing page (Variant A from consensus df14d789-6b714276) at /overview
 * and at / when ?expert=1 is not set. Composes 6 widgets in a narrow readable
 * column. The dense /Dashboard view is reachable via ?expert=1 and is
 * byte-identical to the historical layout — that's the iron law.
 *
 * Spec: docs/specs/2026-05-04-overview-route-design.md (gitignored — refer by path).
 */
export function OverviewPage({
  overview,
  agents,
  tasks,
  activeTaskCount,
  setActiveTaskCount,
}: OverviewPageProps) {
  const actionable = overview.actionableFindings;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Page header */}
      <header>
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-mono text-2xl font-bold tracking-tight text-foreground font-serif-editorial">
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
        <p className="mt-1 font-mono text-[13px] text-muted-foreground">
          What your agents are doing right now.
        </p>
      </header>

      {/* Hero strip — calm SystemPulse */}
      <SystemPulse
        overview={overview}
        activeTasks={activeTaskCount}
        mode="calm"
      />

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
