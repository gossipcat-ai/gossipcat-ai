import type { OverviewData } from '@/lib/types';
import { timeAgo } from '@/lib/utils';
import { href } from '@/lib/router';
import { EmptyState } from './EmptyState';

interface SystemPulseProps {
  overview: OverviewData;
  activeTasks: number;
  /**
   * 'dense' (default) — full operator strip with 3-row agent block,
   * secondary-stats list, Actionable BigStat, and ActivityBars.
   * 'calm' — Overview/landing variant: only 3 BigStats
   * (Agents online / Active tasks / Confirmed %).
   */
  mode?: 'dense' | 'calm';
  /**
   * Whether to show the ActivityBars row. Defaults to `true` (matching
   * historical behavior). On `mode='calm'` the OverviewPage passes `false`
   * to keep the strip hero-proportioned (~80px shorter).
   */
  showActivity?: boolean;
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
  /** Non-theme Tailwind class for the value (e.g. text-confirmed, text-unverified, text-orange-400).
   *  Pass empty string to fall back to var(--text). Theme-sensitive colours
   *  are handled via valueColor instead. */
  valueClass?: string;
  /** Inline CSS color override — takes precedence over valueClass when set. */
  valueColor?: string;
  pulse?: boolean;
  tooltip?: string;
}

function BigStat({ value, unit, label, valueClass = '', valueColor, pulse, tooltip }: BigStatProps) {
  return (
    <div className="flex flex-col items-center py-4 px-3 text-center" data-tooltip={tooltip}>
      <div className="flex items-baseline gap-1">
        {pulse && (
          <span className="relative mr-1 inline-flex h-2 w-2">
            <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-unverified/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-unverified" />
          </span>
        )}
        <span
          className={`font-mono text-2xl font-medium leading-none tracking-[-0.025em] ${valueClass}`}
          style={valueColor ? { color: valueColor } : undefined}
        >
          {value}
        </span>
        {unit && <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{unit}</span>}
      </div>
      <div className="mt-1.5 text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
        {label}
      </div>
    </div>
  );
}

export function SystemPulse({ overview, activeTasks, mode = 'dense', showActivity }: SystemPulseProps) {
  const totalAgents = overview.relayCount + overview.nativeCount;
  const successRate = overview.tasksCompleted + overview.tasksFailed > 0
    ? Math.round((overview.tasksCompleted / (overview.tasksCompleted + overview.tasksFailed)) * 100)
    : null;
  const confirmRate = overview.totalFindings > 0
    ? Math.round((overview.confirmedFindings / overview.totalFindings) * 100)
    : 0;

  const isCalm = mode === 'calm';
  // ActivityBars default: visible in dense, hidden in calm. Prop overrides.
  const activityVisible = showActivity ?? !isCalm;

  // Day-1 onboarding empty state: only meaningful in calm mode when the fleet
  // is unregistered. Avoids three "0" stats reading as a broken dashboard.
  const day1Empty = isCalm && totalAgents === 0;

  return (
    <div className="rounded-lg border border-border" style={{ background: 'var(--surface-elev)' }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3.5 py-3" style={{ background: 'color-mix(in oklch, var(--accent) 3%, transparent)' }}>
        <div className="font-mono text-[11px] font-bold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
          System Pulse
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-confirmed">
          <span className="h-1.5 w-1.5 rounded-full bg-confirmed" />
          LIVE
        </div>
      </div>

      {day1Empty ? (
        <EmptyState
          title="No agents registered yet"
          hint="Run `gossip_setup` or see docs/ to get started."
        />
      ) : isCalm ? (
        // Calm: 3 BigStats — Agents online / Active tasks / Confirmed %.
        <div className="grid grid-cols-3 border-b border-border">
          <div className="border-r border-border">
            <BigStat
              value={overview.agentsOnline}
              label="Agents Online"
              valueColor={overview.agentsOnline > 0 ? 'var(--accent)' : 'var(--text)'}
            />
          </div>
          <div className="border-r border-border">
            <BigStat
              value={activeTasks}
              label="Active Tasks"
              valueClass={activeTasks > 0 ? 'text-unverified' : ''}
              valueColor={activeTasks > 0 ? undefined : 'var(--text-dim)'}
              pulse={activeTasks > 0}
            />
          </div>
          <BigStat
            value={`${confirmRate}%`}
            label="Confirmed"
            valueClass={confirmRate >= 50 ? 'text-confirmed' : confirmRate > 0 ? 'text-unverified' : ''}
            valueColor={confirmRate === 0 ? 'var(--text-dim)' : undefined}
          />
        </div>
      ) : (
        // Dense: original 2x2 grid with 3-row agent block + Actionable row.
        <div className="border-b border-border">
          <div className="relative grid grid-cols-2">
            <span className="pointer-events-none absolute left-0 right-0 top-1/2 h-px bg-border" />
            <span className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px bg-border" />
            {/* Three-row agent stat (stacked to fit narrow cell) */}
            <div className="flex flex-col items-stretch justify-center gap-1.5 px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-dim)' }} data-tooltip="Agents currently executing a task">Dispatched</span>
                <span
                  className="font-mono text-base font-bold leading-none"
                  style={{ color: overview.agentsOnline > 0 ? 'var(--accent)' : 'var(--text)' }}
                >{overview.agentsOnline}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-dim)' }} data-tooltip="Relay agents with an active WebSocket connection">Connected</span>
                <span className={`font-mono text-base font-bold leading-none ${overview.relayConnected > 0 ? 'text-confirmed' : ''}`} style={overview.relayConnected > 0 ? undefined : { color: 'var(--text-dim)' }}>{overview.relayConnected}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-dim)' }} data-tooltip="Total agents in gossipcat config">Registered</span>
                <span className="font-mono text-base font-bold leading-none" style={{ color: 'var(--text-dim)' }}>{totalAgents}</span>
              </div>
            </div>
            <BigStat
              value={activeTasks}
              label="Active Tasks"
              valueClass={activeTasks > 0 ? 'text-unverified' : ''}
              valueColor={activeTasks > 0 ? undefined : 'var(--text-dim)'}
              pulse={activeTasks > 0}
            />
            <BigStat
              value={overview.consensusRuns}
              label="Consensus"
              valueColor="var(--text)"
            />
            <BigStat
              value={`${confirmRate}%`}
              label="Confirmed"
              valueClass="text-confirmed"
            />
          </div>
          <a
            href={href('/signals?signal=disagreement&signal=hallucination_caught&signal=new_finding')}
            className="block cursor-pointer border-t border-border transition-colors hover:bg-accent/30"
            aria-label="View actionable findings on Signals page"
          >
            <BigStat
              value={overview.actionableFindings}
              label="Actionable"
              valueClass={overview.actionableFindings > 0 ? 'text-orange-400' : 'text-confirmed'}
              tooltip="Findings still open and need operator review (disagreements + hallucinations + new findings)"
            />
          </a>
        </div>
      )}

      {/* Secondary stats — dense only */}
      {!isCalm && (
        <div className="px-3.5 py-3">
          <div className="flex items-center justify-between py-1 font-mono text-[11px]">
            <span style={{ color: 'var(--text-dim)' }}>tasks completed</span>
            <span className="font-semibold tabular-nums" style={{ color: 'var(--text)' }}>{overview.tasksCompleted}</span>
          </div>
          <div className="flex items-center justify-between py-1 font-mono text-[11px]">
            <span style={{ color: 'var(--text-dim)' }}>signals total</span>
            <span className="font-semibold tabular-nums" style={{ color: 'var(--text)' }}>{overview.totalSignals}</span>
          </div>
          {overview.tasksFailed > 0 && (
            <div className="flex items-center justify-between py-1 font-mono text-[11px]">
              <span style={{ color: 'var(--text-dim)' }}>tasks failed</span>
              <span className="font-semibold text-destructive tabular-nums">{overview.tasksFailed}</span>
            </div>
          )}
          <div className="flex items-center justify-between py-1 font-mono text-[11px]">
            <span style={{ color: 'var(--text-dim)' }}>avg duration</span>
            <span className="font-semibold tabular-nums" style={{ color: 'var(--text)' }}>{formatDuration(overview.avgDurationMs)}</span>
          </div>
          <div className="flex items-center justify-between py-1 font-mono text-[11px]">
            <span style={{ color: 'var(--text-dim)' }}>success rate</span>
            <span
              className={`font-semibold tabular-nums ${successRate !== null && successRate >= 95 ? 'text-confirmed' : successRate !== null && successRate >= 80 ? 'text-unverified' : successRate !== null ? 'text-destructive' : ''}`}
              style={successRate === null ? { color: 'var(--text-dim)' } : undefined}
            >
              {successRate === null ? '—' : `${successRate}%`}
            </span>
          </div>
        </div>
      )}

      {/* Activity last 12h — gated by activityVisible (default: dense=true, calm=false) */}
      {activityVisible && <ActivityBars hourly={overview.hourlyActivity || []} />}

      {/* Last consensus footer */}
      {overview.lastConsensusTimestamp && (
        <div className="border-t border-border px-3.5 py-2 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>
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
    <div className="border-t border-border px-3.5 py-3" style={{ background: 'color-mix(in oklch, var(--accent) 2%, transparent)' }}>
      <div className="mb-2 font-mono text-[9px] font-bold uppercase tracking-widest" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>
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
                count === 0 ? 'opacity-0' : isNow ? 'bg-chart opacity-90' : 'bg-chart opacity-40'
              }`}
              style={{ height: count === 0 ? '0%' : `${Math.max(8, heightPct)}%` }}
              data-tooltip={`${label}\n${count} task${count === 1 ? '' : 's'}`}
              data-tooltip-pos="bottom"
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 40%, transparent)' }}>
        <span>12h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
