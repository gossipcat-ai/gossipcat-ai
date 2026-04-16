import type { OverviewData } from '@/lib/types';
import { timeAgo } from '@/lib/utils';

interface SystemPulseProps {
  overview: OverviewData;
  activeTasks: number;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

interface BigStatProps {
  value: string | number;
  unit?: string;
  label: string;
  valueClass: string;
  pulse?: boolean;
}

function BigStat({ value, unit, label, valueClass, pulse }: BigStatProps) {
  return (
    <div className="flex flex-col items-center py-4 px-3 text-center">
      <div className="flex items-baseline gap-1">
        {pulse && (
          <span className="relative mr-1 inline-flex h-2 w-2">
            <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-unverified/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-unverified" />
          </span>
        )}
        <span className={`font-mono text-2xl font-bold leading-none ${valueClass}`}>{value}</span>
        {unit && <span className="font-mono text-xs text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

export function SystemPulse({ overview, activeTasks }: SystemPulseProps) {
  const totalAgents = overview.relayCount + overview.nativeCount;
  const successRate = overview.tasksCompleted + overview.tasksFailed > 0
    ? Math.round((overview.tasksCompleted / (overview.tasksCompleted + overview.tasksFailed)) * 100)
    : 100;
  const confirmRate = overview.totalFindings > 0
    ? Math.round((overview.confirmedFindings / overview.totalFindings) * 100)
    : 0;

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-primary/[0.03] px-3.5 py-3">
        <div className="font-mono text-[11px] font-bold uppercase tracking-widest text-primary">
          System Pulse
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-confirmed">
          <span className="h-1.5 w-1.5 rounded-full bg-confirmed shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
          LIVE
        </div>
      </div>

      {/* Primary 2x2 grid with cross dividers */}
      <div className="relative grid grid-cols-2 border-b border-border">
        <span className="pointer-events-none absolute left-0 right-0 top-1/2 h-px bg-border" />
        <span className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px bg-border" />
        <BigStat
          value={overview.agentsOnline}
          unit={`/${totalAgents}`}
          label="Agents Online"
          valueClass="text-confirmed"
        />
        <BigStat
          value={activeTasks}
          label="Active Tasks"
          valueClass={activeTasks > 0 ? 'text-unverified' : 'text-muted-foreground'}
          pulse={activeTasks > 0}
        />
        <BigStat
          value={overview.consensusRuns}
          label="Consensus"
          valueClass="text-foreground"
        />
        <BigStat
          value={`${confirmRate}%`}
          label="Confirmed"
          valueClass="text-confirmed"
        />
      </div>

      {/* Secondary stats */}
      <div className="px-3.5 py-3">
        <div className="flex items-center justify-between py-1 font-mono text-[11px]">
          <span className="text-muted-foreground">tasks completed</span>
          <span className="font-semibold text-foreground tabular-nums">{overview.tasksCompleted}</span>
        </div>
        <div className="flex items-center justify-between py-1 font-mono text-[11px]">
          <span className="text-muted-foreground">signals total</span>
          <span className="font-semibold text-foreground tabular-nums">{overview.totalSignals}</span>
        </div>
        <div className="flex items-center justify-between py-1 font-mono text-[11px]">
          <span className="text-muted-foreground">actionable</span>
          <span className="font-semibold text-unverified tabular-nums">{overview.actionableFindings}</span>
        </div>
        {overview.tasksFailed > 0 && (
          <div className="flex items-center justify-between py-1 font-mono text-[11px]">
            <span className="text-muted-foreground">tasks failed</span>
            <span className="font-semibold text-destructive tabular-nums">{overview.tasksFailed}</span>
          </div>
        )}
        <div className="flex items-center justify-between py-1 font-mono text-[11px]">
          <span className="text-muted-foreground">avg duration</span>
          <span className="font-semibold text-foreground tabular-nums">{formatDuration(overview.avgDurationMs)}</span>
        </div>
        <div className="flex items-center justify-between py-1 font-mono text-[11px]">
          <span className="text-muted-foreground">success rate</span>
          <span className={`font-semibold tabular-nums ${successRate >= 95 ? 'text-confirmed' : successRate >= 80 ? 'text-unverified' : 'text-destructive'}`}>
            {successRate}%
          </span>
        </div>
      </div>

      {/* Activity last 12h */}
      <ActivityBars hourly={overview.hourlyActivity || []} />

      {/* Last consensus footer */}
      {overview.lastConsensusTimestamp && (
        <div className="border-t border-border px-3.5 py-2 font-mono text-[10px] text-muted-foreground/60">
          last consensus {timeAgo(overview.lastConsensusTimestamp)}
        </div>
      )}
    </div>
  );
}

interface ActivityBarsProps {
  hourly: number[];
}

function ActivityBars({ hourly }: ActivityBarsProps) {
  // Ensure 12 entries
  const bars = hourly.length === 12 ? hourly : new Array(12).fill(0);
  const max = Math.max(1, ...bars);
  return (
    <div className="border-t border-border bg-primary/[0.02] px-3.5 py-3">
      <div className="mb-2 font-mono text-[9px] font-bold uppercase tracking-widest text-muted-foreground/60">
        Activity Last 12h
      </div>
      <div className="flex h-6 items-end gap-0.5">
        {bars.map((count, i) => {
          const hoursAgo = 11 - i;
          const heightPct = (count / max) * 100;
          const isNow = i === 11;
          const label = hoursAgo === 0 ? 'last hour' : `${hoursAgo}h ago`;
          return (
            <div
              key={i}
              className={`relative flex-1 cursor-pointer rounded-sm transition-opacity hover:opacity-100 ${
                isNow ? 'bg-chart opacity-90' : 'bg-chart opacity-40'
              }`}
              style={{ height: `${Math.max(8, heightPct)}%` }}
              data-tooltip={`${label}\n${count} task${count === 1 ? '' : 's'}`}
              data-tooltip-pos="bottom"
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground/40">
        <span>12h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
