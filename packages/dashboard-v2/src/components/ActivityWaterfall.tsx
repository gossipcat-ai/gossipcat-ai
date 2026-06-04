import { useMemo } from 'react';
import type { AgentData, ConsensusRun } from '@/lib/types';
import { agentColor } from '@/lib/utils';

/** 24h activity waterfall — per-agent heatmap of signal volume by hour.
 *
 *  DESIGN.md Step 5 replacement for the SystemPulse "0 / 0 / 71%" three-zeros
 *  empty state. Each agent gets a row of 24 cells (one per hour of the
 *  rolling 24h window ending now). Cell intensity = signal volume in that
 *  hour relative to the row's max.
 *
 *  State coverage per DESIGN.md "State coverage" subsection:
 *    - Full:    matrix rendered with shaded cells
 *    - Loading: skeleton rows (border-opacity-40)
 *    - Empty:   structural frame preserved, row cells dimmed, contextual
 *               subhead replaces meaningless zeros
 *    - Error:   chip-bad with reason at top-right; cached data preserved
 *               dimmed at 50% opacity
 */
interface ActivityWaterfallProps {
  agents: AgentData[];
  runs: ConsensusRun[] | null | undefined;
  loading?: boolean;
  error?: string | null;
}

const HOURS = 24;
const NOW_OFFSET_MS = 60 * 60 * 1000;
const WINDOW_MS = HOURS * NOW_OFFSET_MS;

/** Compute a per-agent 24-hour signal-count matrix from consensus runs.
 *  Bucket index 0 = oldest (24h ago), HOURS-1 = current hour. */
function bucketActivity(runs: ConsensusRun[], agents: AgentData[], nowMs: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const a of agents) out.set(a.id, new Array(HOURS).fill(0));
  const cutoffMs = nowMs - WINDOW_MS;
  for (const run of runs) {
    if (run.retracted) continue;
    const ts = Date.parse(run.timestamp);
    if (isNaN(ts) || ts < cutoffMs || ts > nowMs) continue;
    const bucket = Math.min(HOURS - 1, Math.floor((ts - cutoffMs) / NOW_OFFSET_MS));
    for (const sig of run.signals ?? []) {
      const row = out.get(sig.agentId);
      if (row) row[bucket] += 1;
    }
  }
  return out;
}

/** Map a 0..1 normalized intensity to a discrete level (0..4) for the
 *  heatmap shading. Discrete bands read more clearly than continuous opacity. */
function intensityLevel(value: number, rowMax: number): 0 | 1 | 2 | 3 | 4 {
  if (rowMax <= 0 || value <= 0) return 0;
  const t = value / rowMax;
  if (t < 0.18) return 1;
  if (t < 0.40) return 2;
  if (t < 0.68) return 3;
  return 4;
}

const LEVEL_OPACITY: Record<0 | 1 | 2 | 3 | 4, number> = {
  0: 0.18,
  1: 0.35,
  2: 0.55,
  3: 0.78,
  4: 1.0,
};

// Per-agent identity color imported from @/lib/utils — canonical source
// (AGENT_IDENTITY_TABLE, sourced from DESIGN.md §Per-agent identity). The
// previous local switch duplicated the 7-agent table and hardcoded a fallback
// hex, risking silent drift if globals.css identity tokens changed.

export function ActivityWaterfall({ agents, runs, loading = false, error = null }: ActivityWaterfallProps) {
  const nowMs = Date.now();
  // Memoize the bucket computation — re-runs only when the underlying data
  // changes, not on every parent re-render.
  const buckets = useMemo(
    () => bucketActivity(runs ?? [], agents, nowMs),
    // nowMs intentionally excluded — bucketing is recomputed on data changes,
    // not wall-clock ticks (each hour boundary would re-render but that's fine).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs, agents],
  );

  // Per-row totals for the right-side count column.
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, row] of buckets) m.set(id, row.reduce((a, b) => a + b, 0));
    return m;
  }, [buckets]);

  const fleetTotal = useMemo(() => {
    let t = 0;
    for (const v of totals.values()) t += v;
    return t;
  }, [totals]);

  // Loading skeleton — show structural frame with grey cells, no labels populated.
  if (loading && agents.length === 0) {
    return (
      <WaterfallShell error={null} fleetTotal={null}>
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </WaterfallShell>
    );
  }

  // True empty — no agents AND no activity. Replace cells with a single
  // contextual line. Never show three naked zeros.
  if (agents.length === 0) {
    return (
      <WaterfallShell error={error} fleetTotal={null}>
        <div className="px-5 py-6 font-mono text-xs" style={{ color: 'var(--ink-3)' }}>
          No agents registered yet — run <code className="rounded bg-[var(--surface-sunk)] px-1.5 py-0.5">gossip_setup</code> to spin up the fleet.
        </div>
      </WaterfallShell>
    );
  }

  // Fleet has agents but no activity in the last 24h, OR run data is missing
  // (runs == null). Distinguish the two so a disconnected relay doesn't
  // misreport as "fleet idle" — the latter is factually wrong when we never
  // received run data at all.
  if (fleetTotal === 0) {
    const message = runs == null
      ? 'Run data unavailable — relay may be disconnected. Showing idle rows from the agent registry.'
      : 'No active dispatches — fleet idle.';
    return (
      <WaterfallShell error={error} fleetTotal={0}>
        {agents.map((agent) => (
          <IdleRow key={agent.id} agent={agent} />
        ))}
        <div className="px-5 py-3 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          {message}
        </div>
      </WaterfallShell>
    );
  }

  return (
    <WaterfallShell error={error} fleetTotal={fleetTotal}>
      {agents.map((agent) => {
        const row = buckets.get(agent.id) ?? new Array(HOURS).fill(0);
        const rowMax = Math.max(0, ...row);
        const rowTotal = totals.get(agent.id) ?? 0;
        const pct = fleetTotal > 0 ? Math.round((rowTotal / fleetTotal) * 100) : 0;
        const color = agentColor(agent.id);
        return (
          <div
            key={agent.id}
            className="grid items-center gap-3 border-b border-border px-5 py-2 last:border-b-0"
            style={{ gridTemplateColumns: '160px 1fr 110px' }}
          >
            {/* Agent name + identity dot */}
            <div className="flex items-center gap-2 font-mono text-[12px]" style={{ color: 'var(--ink)' }}>
              <span
                className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                style={{ background: color }}
              />
              <span className="truncate">{agent.id}</span>
            </div>

            {/* 24-cell heatmap */}
            <div
              className="grid h-4 gap-px"
              style={{ gridTemplateColumns: `repeat(${HOURS}, 1fr)` }}
              role="img"
              aria-label={`${agent.id} 24h activity — ${rowTotal} signals`}
            >
              {row.map((count, h) => {
                const level = intensityLevel(count, rowMax);
                return (
                  <div
                    key={h}
                    className="rounded-sm"
                    title={`hour ${h}: ${count} signal${count === 1 ? '' : 's'}`}
                    style={{
                      background: level === 0 ? 'var(--surface-sunk)' : color,
                      opacity: LEVEL_OPACITY[level],
                    }}
                  />
                );
              })}
            </div>

            {/* Row total + % of fleet */}
            <div className="text-right font-mono text-[12px] tabular-nums" style={{ color: 'var(--ink)' }}>
              {rowTotal}
              <span className="ml-1.5 text-[11px]" style={{ color: 'var(--ink-3)' }}>{pct}%</span>
            </div>
          </div>
        );
      })}
    </WaterfallShell>
  );
}

function WaterfallShell({ children, error, fleetTotal }: { children: React.ReactNode; error: string | null; fleetTotal: number | null }) {
  return (
    <div className="rounded-lg border border-border" style={{ background: 'var(--surface-elev)' }}>
      {/* Header row — section label + 24h scale + signals total */}
      <div
        className="grid items-end gap-3 border-b border-border px-5 py-3"
        style={{ gridTemplateColumns: '160px 1fr 110px' }}
      >
        <div className="h-section">Agent · 24h activity</div>
        <div
          className="grid font-mono text-[9px]"
          style={{ gridTemplateColumns: `repeat(${HOURS}, 1fr)`, color: 'var(--ink-3)' }}
        >
          {Array.from({ length: HOURS }).map((_, h) => (
            <span key={h} className="text-center">
              {h % 2 === 0 ? String(h).padStart(2, '0') : ''}
            </span>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          {error ? (
            <span className="rounded-sm border px-2 py-0.5 font-mono text-[10px]" style={{
              borderColor: 'var(--danger)',
              background: 'color-mix(in oklch, var(--danger) 12%, transparent)',
              color: 'var(--danger)',
            }}>
              {error}
            </span>
          ) : fleetTotal !== null ? (
            <div className="h-section" style={{ color: 'var(--ink-3)' }}>
              Signals · 24h <span className="ml-1.5 tabular-nums" style={{ color: 'var(--ink)' }}>{fleetTotal}</span>
            </div>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div
      className="grid items-center gap-3 border-b border-border px-5 py-2 last:border-b-0"
      style={{ gridTemplateColumns: '160px 1fr 110px' }}
    >
      <div className="h-3 w-32 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
      <div className="grid h-4 gap-px" style={{ gridTemplateColumns: `repeat(${HOURS}, 1fr)` }}>
        {Array.from({ length: HOURS }).map((_, i) => (
          <div key={i} className="rounded-sm" style={{ background: 'var(--border)', opacity: 0.4 }} />
        ))}
      </div>
      <div className="ml-auto h-3 w-12 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
    </div>
  );
}

function IdleRow({ agent }: { agent: AgentData }) {
  const color = agentColor(agent.id);
  return (
    <div
      className="grid items-center gap-3 border-b border-border px-5 py-2 last:border-b-0"
      style={{ gridTemplateColumns: '160px 1fr 110px' }}
    >
      <div className="flex items-center gap-2 font-mono text-[12px]" style={{ color: 'var(--ink-3)' }}>
        <span
          className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
          style={{ background: color, opacity: 0.5 }}
        />
        <span className="truncate">{agent.id}</span>
      </div>
      <div
        className="grid h-4 gap-px"
        style={{ gridTemplateColumns: `repeat(${HOURS}, 1fr)` }}
      >
        {Array.from({ length: HOURS }).map((_, h) => (
          <div key={h} className="rounded-sm" style={{ background: 'var(--surface-sunk)', opacity: 0.4 }} />
        ))}
      </div>
      <div className="text-right font-mono text-[12px]" style={{ color: 'var(--ink-3)' }}>—</div>
    </div>
  );
}

