import { useCallback, useMemo, useState } from 'react';
import { useRoute } from '@/lib/router';
import { OverviewPage } from '@/pages/OverviewPage';
import { ConsensusFlowPage } from '@/pages/ConsensusFlowPage';
import { AuthGate } from '@/components/AuthGate';
import { TopBar } from '@/components/TopBar';
import { NeuralAvatar } from '@/components/NeuralAvatar';
import { TaskDetailModal } from '@/components/TaskDetailModal';
import { FindingsMetrics } from '@/components/FindingsMetrics';
import { ViolationsPage } from '@/components/ViolationsPage';
import { AgentPage } from '@/components/AgentPage';
import { LogsPage } from '@/components/LogsPage';
import { SignalsPage } from '@/components/SignalsPage';
import { TaskRow } from '@/components/TaskRow';
import { OverviewSkeleton, TeamPageSkeleton, TasksPageSkeleton, DebatesPageSkeleton } from '@/components/Skeleton';
import { useAuth } from '@/hooks/useAuth';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useDashboardData } from '@/hooks/useDashboardData';
import { timeAgo } from '@/lib/utils';
import { getBenchBadgeKind, needsAttention } from '@/lib/bench';
import { NotificationStack } from '@/components/NotificationStack';
import { useSeverityCounts } from '@/hooks/useSeverityCounts';
import { AgentCardBig } from '@/components/AgentCardBig';
import type { DashboardEvent, AgentData, ConsensusReportsData, FleetTrendResponse, FleetTrendPoint } from '@/lib/types';

type SortKey = 'weight' | 'accuracy' | 'uniqueness' | 'impact' | 'signals' | 'agreements' | 'hallucinations' | 'lastTask';

function TeamPage({
  agents,
  tasks,
  consensusReports,
  fleetTrend,
}: {
  agents: AgentData[];
  tasks: import('@/lib/types').TasksData | null;
  consensusReports?: ConsensusReportsData | null;
  fleetTrend?: FleetTrendResponse | null;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('weight');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [query, setQuery] = useState('');

  // Build a map from agentId → most recent task item
  const lastTaskByAgent = useMemo(() => {
    const m = new Map<string, import('@/lib/types').TaskItem>();
    if (tasks) {
      for (const t of tasks.items) {
        const existing = m.get(t.agentId);
        if (!existing || t.timestamp > existing.timestamp) m.set(t.agentId, t);
      }
    }
    return m;
  }, [tasks]);

  // Step 6 — severity counts derived client-side from consensus reports
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
      // Sort each series ascending by day
      for (const arr of m.values()) {
        arr.sort((a, b) => a.day.localeCompare(b.day));
      }
    }
    return m;
  }, [fleetTrend]);

  const circuitOpen = agents.filter(needsAttention).length;
  const healthy = agents.filter((a) => a.scores.accuracy >= 0.5).length;
  const totalSignals = agents.reduce((acc, a) => acc + a.scores.signals, 0);
  const totalTokens = agents.reduce((acc, a) => acc + a.totalTokens, 0);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? agents.filter((a) =>
        a.id.toLowerCase().includes(q) ||
        a.provider.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q)
      )
    : agents;

  const sortVal = (a: AgentData): number => {
    const s = a.scores;
    switch (sortKey) {
      case 'weight': return s.dispatchWeight;
      case 'accuracy': return s.accuracy;
      case 'uniqueness': return s.uniqueness;
      case 'impact': return s.impactScore;
      case 'signals': return s.signals;
      case 'agreements': return s.agreements;
      case 'hallucinations': return s.hallucinations;
      case 'lastTask': {
        const lt = lastTaskByAgent.get(a.id);
        return lt ? new Date(lt.timestamp).getTime() : 0;
      }
    }
  };
  const sorted = [...filtered].sort((a, b) => {
    const va = sortVal(a); const vb = sortVal(b);
    return sortDir === 'desc' ? vb - va : va - vb;
  });

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const arrow = (k: SortKey) => sortKey === k ? (sortDir === 'desc' ? '▾' : '▴') : '';

  return (
    <>
      {/* Header with summary stats */}
      <div className="mb-6">
        <div className="flex items-baseline gap-3">
          <h1 className="h-route">Team</h1>
          <span className="font-mono text-sm tabular-nums" style={{ color: 'var(--ink-3)' }}>{agents.length}</span>
        </div>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--ink-3)' }}>Per-agent accuracy, signal counts, and dispatch weights.</p>
        <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-md [border-color:color-mix(in_oklch,var(--border)_40%,transparent)] border [background:color-mix(in_oklch,var(--border)_30%,transparent)] sm:grid-cols-4">
          {[
            { label: 'Healthy', value: healthy, varColor: 'var(--ok)' },
            { label: 'Benched', value: circuitOpen, varColor: circuitOpen > 0 ? 'var(--bad)' : 'var(--ink-3)' },
            { label: 'Total Signals', value: totalSignals.toLocaleString(), varColor: 'var(--ink)' },
            { label: 'Tokens Used', value: totalTokens.toLocaleString(), varColor: 'var(--ink)' },
          ].map((stat) => (
            <div key={stat.label} style={{ background: 'var(--surface-elev)' }} className="px-4 py-3">
              <div className="font-mono text-lg font-bold tabular-nums" style={{ color: stat.varColor }}>{stat.value}</div>
              <div className="h-section mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search agents by id, provider, or model..."
          className="w-full max-w-md rounded-md [border-color:color-mix(in_oklch,var(--border)_40%,transparent)] border px-3 py-1.5 font-mono text-xs focus:[border-color:var(--ink-3)] focus:outline-none"
          style={{ background: 'color-mix(in oklch, var(--surface-elev) 80%, transparent)', color: 'var(--ink)' }}
        />
      </div>

      {/* Leaderboard table */}
      <div className="overflow-hidden rounded-md [border-color:color-mix(in_oklch,var(--border)_40%,transparent)] border" style={{ background: 'color-mix(in oklch, var(--surface-elev) 80%, transparent)' }}>
        <table className="w-full text-left">
          <colgroup>
            <col style={{ width: 44 }} />
            <col />
            <col style={{ width: 80 }} />
            <col style={{ width: 260 }} />
            <col style={{ width: 80 }} />
            <col style={{ width: 60 }} />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b [border-color:color-mix(in_oklch,var(--border)_40%,transparent)]" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 20%, transparent)' }}>
              <th className="h-section py-2.5 pl-5 pr-2 text-center">#</th>
              <th className="h-section py-2.5 pr-3 text-left">Agent</th>
              <th className="h-section py-2.5 pr-4 text-right cursor-pointer select-none hover:[color:var(--ink)]" onClick={() => toggleSort('weight')}>
                Weight {arrow('weight')}
              </th>
              <th className="h-section py-2.5 pr-4 text-left align-top">
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleSort('accuracy')} className="flex items-center gap-1 hover:[color:var(--ink)]" data-tooltip="Accuracy — fraction of findings confirmed by cross-review (with hallucination penalty)">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-confirmed" />Acc{arrow('accuracy')}
                  </button>
                  <span style={{ color: 'color-mix(in oklch, var(--ink-3) 30%, transparent)' }}>·</span>
                  <button onClick={() => toggleSort('uniqueness')} className="flex items-center gap-1 hover:[color:var(--ink)]" data-tooltip="Uniqueness — findings this agent surfaced that no peer found">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-unique" />Unq{arrow('uniqueness')}
                  </button>
                  <span style={{ color: 'color-mix(in oklch, var(--ink-3) 30%, transparent)' }}>·</span>
                  <button onClick={() => toggleSort('impact')} className="flex items-center gap-1 hover:[color:var(--ink)]" data-tooltip="Impact — severity-weighted finding score">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--c8)]" />Imp{arrow('impact')}
                  </button>
                </div>
              </th>
              <th className="h-section py-2.5 pr-4 text-right cursor-pointer select-none hover:[color:var(--ink)]" onClick={() => toggleSort('signals')}>
                Signals {arrow('signals')}
              </th>
              <th
                className="h-section py-2.5 pr-4 text-right cursor-pointer select-none hover:[color:var(--ink)]"
                onClick={() => toggleSort('hallucinations')}
                data-tooltip="Hallucinations — fabricated findings caught by cross-review"
              >
                Halluc {arrow('hallucinations')}
              </th>
              <th className="h-section py-2.5 pr-5 text-left cursor-pointer select-none hover:[color:var(--ink)]" onClick={() => toggleSort('lastTask')}>
                Last Task {arrow('lastTask')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((agent, i) => {
              const s = agent.scores;
              const lt = lastTaskByAgent.get(agent.id);
              const weightColor = s.dispatchWeight >= 1.2 ? 'var(--ok)' : s.dispatchWeight >= 0.8 ? 'var(--ink)' : 'var(--bad)';
              const rankDisplay = i + 1;

              return (
                <tr
                  key={agent.id}
                  className="group border-t [border-color:color-mix(in_oklch,var(--border)_20%,transparent)] align-top transition-colors hover:bg-accent/20"
                >
                  {/* Rank */}
                  <td className="py-3 pl-5 pr-2 text-center align-top">
                    <span
                      className="font-mono text-[11px] tabular-nums"
                      style={{
                        color: rankDisplay === 1 ? 'var(--ink)' :
                               rankDisplay === 2 || rankDisplay === 3 ? 'color-mix(in oklch, var(--ink-2) 80%, transparent)' :
                               'var(--ink-3)',
                        fontWeight: rankDisplay === 1 ? 'bold' : rankDisplay <= 3 ? 600 : undefined,
                      }}
                    >{rankDisplay}</span>
                  </td>

                  {/* Agent */}
                  <td className="py-2.5 pr-3 align-top">
                    <a href={`/dashboard/agent/${encodeURIComponent(agent.id)}`} className="flex items-center gap-3">
                      <NeuralAvatar
                        agentId={agent.id}
                        size={32}
                        signals={s.signals}
                        accuracy={s.accuracy}
                        uniqueness={s.uniqueness}
                        impact={s.impactScore}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-xs font-semibold group-hover:[color:var(--accent)]" style={{ color: 'var(--ink)' }}>{agent.id}</span>
                          {(() => {
                            const kind = getBenchBadgeKind(s);
                            if (kind === 'benched') return (
                              <span
                                className="shrink-0 rounded px-1 text-[8px] font-bold"
                                style={{ background: 'color-mix(in oklch, var(--bad) 15%, transparent)', color: 'var(--bad)', fontVariant: 'small-caps', letterSpacing: '0.04em' }}
                                data-tooltip={`Benched (${s.bench.reason ?? 'auto'}). Excluded from dispatch until recovery.`}
                              >benched</span>
                            );
                            if (kind === 'struggling') return (
                              <span
                                className="shrink-0 rounded bg-unverified/15 px-1 text-[8px] font-bold text-unverified"
                                style={{ fontVariant: 'small-caps', letterSpacing: '0.04em' }}
                                data-tooltip="Struggling: consecutive failures tripped the circuit breaker. Deprioritized until new clean signals recover the score."
                              >struggling</span>
                            );
                            if (kind === 'kept-for-coverage') return (
                              <span
                                className="shrink-0 rounded border border-unverified/40 px-1 text-[8px] font-bold text-unverified"
                                style={{ fontVariant: 'small-caps', letterSpacing: '0.04em' }}
                                data-tooltip={`Would bench (${s.bench.reason ?? 'rule'}), but kept as sole provider of a category.`}
                              >kept for coverage</span>
                            );
                            return null;
                          })()}
                        </div>
                        <div className="truncate font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>
                          {agent.provider}/{agent.model}
                        </div>
                      </div>
                    </a>
                  </td>

                  {/* Weight */}
                  <td className="py-3 pr-4 text-right align-top">
                    <span className="font-mono text-sm font-bold tabular-nums" style={{ color: weightColor }}>{s.dispatchWeight.toFixed(2)}</span>
                  </td>

                  {/* Metrics: three mini bars stacked — Acc / Unq / Imp.
                      Reliability row removed pending backend taskCompletionRate
                      wiring (consensus eee614bd-31ba4209 + task-graph emission). */}
                  <td className="py-3 pr-4 align-top">
                    <div className="space-y-1">
                      <MiniBar
                        label="A"
                        value={s.accuracy}
                        fillClass={s.accuracy >= 0.7 ? 'bg-confirmed' : s.accuracy >= 0.4 ? 'bg-unverified' : 'bg-disputed'}
                        tooltip="Adjusted accuracy = raw signal ratio × 1/(1 + weighted hallucinations × 0.3). The penalty is recoverable via skill-gated multiplier in the same category."
                      />
                      <MiniBar label="U" value={s.uniqueness} fillClass="bg-unique" tooltip="Uniqueness — findings this agent surfaced that no other agent found" />
                      <MiniBar label="I" value={s.impactScore} fillClass="bg-[var(--c8)]" tooltip="Impact — severity-weighted finding score; critical and high findings count more" />
                    </div>
                  </td>

                  {/* Signals */}
                  <td className="py-3 pr-4 text-right align-top font-mono text-xs tabular-nums" style={{ color: 'var(--ink)' }}>
                    {s.signals.toLocaleString()}
                  </td>

                  {/* Hallucinations */}
                  <td className="py-3 pr-4 text-right align-top font-mono text-xs tabular-nums">
                    <span
                      style={{ color: s.hallucinations > 0 ? 'var(--bad)' : 'var(--ink-3)', fontWeight: s.hallucinations > 10 ? 'bold' : undefined }}
                      data-tooltip={`Agreements ${s.agreements} · Disagreements ${s.disagreements} · Hallucinations ${s.hallucinations}`}
                    >
                      {s.hallucinations}
                    </span>
                  </td>

                  {/* Last task */}
                  <td className="py-3 pr-5 align-top">
                    {lt ? (
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="warn-badge shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold">
                          {lt.taskId.slice(0, 8)}
                        </span>
                        <span className="truncate text-[11px]" style={{ maxWidth: 260, color: 'var(--ink-2)' }}>
                          {lt.task}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>{timeAgo(lt.timestamp)}</span>
                      </div>
                    ) : (
                      <span className="font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>no tasks</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MiniBar({ label, value, fillClass, tooltip }: { label: string; value: number; fillClass: string; tooltip?: string }) {
  return (
    <div className="flex items-center gap-2" data-tooltip={tooltip} data-tooltip-pos="top">
      <span className="w-6 text-[10px]" style={{ color: 'var(--ink-3)', fontVariant: 'small-caps', letterSpacing: '0.04em' }}>{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: 'color-mix(in oklch, var(--surface) 60%, transparent)' }}>
        <div className={`h-full rounded-full ${fillClass}`} style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-[10px] tabular-nums" style={{ color: 'var(--ink-2)' }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function TasksPage({ tasks }: { tasks: import('@/lib/types').TasksData }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<import('@/lib/types').TaskItem | null>(null);
  const PAGE_SIZE = 100;

  const completed = tasks.items.filter((t) => t.status === 'completed').length;
  const failed = tasks.items.filter((t) => t.status === 'failed').length;
  const running = tasks.items.filter((t) => t.status === 'running').length;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? tasks.items.filter((t) =>
        t.task?.toLowerCase().includes(q) ||
        t.agentId?.toLowerCase().includes(q) ||
        t.taskId?.toLowerCase().includes(q) ||
        t.status?.toLowerCase().includes(q)
      )
    : tasks.items;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const paged = filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  return (
    <>
      <div className="mb-6">
        <div className="flex items-baseline gap-3">
          <h1 className="h-route">Tasks</h1>
          <span className="font-mono text-sm tabular-nums" style={{ color: 'var(--ink-3)' }}>{tasks.total}</span>
        </div>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--ink-3)' }}>Live dispatched tasks and their relay status.</p>
        <div className="mt-2 flex gap-4 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          <span><span style={{ color: 'var(--ok)' }}>{completed}</span> completed</span>
          {failed > 0 && <span><span style={{ color: 'var(--bad)' }}>{failed}</span> failed</span>}
          {running > 0 && <span><span className="text-unverified">{running}</span> running</span>}
          <span>showing {paged.length} of {filtered.length}{q && ` (filtered from ${tasks.items.length})`}</span>
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          placeholder="Search tasks by description, agent, id, status..."
          className="w-full max-w-md rounded-md [border-color:color-mix(in_oklch,var(--border)_40%,transparent)] border px-3 py-1.5 font-mono text-xs focus:[border-color:color-mix(in_oklch,var(--accent)_40%,transparent)] focus:outline-none"
          style={{ background: 'color-mix(in oklch, var(--surface-elev) 80%, transparent)', color: 'var(--ink)' }}
        />
        <div className={`flex shrink-0 items-center gap-2 font-mono text-[11px] ${totalPages <= 1 ? 'invisible' : ''}`} style={{ color: 'var(--ink-3)' }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
              className="rounded-sm [border-color:color-mix(in_oklch,var(--border)_40%,transparent)] border px-2 py-0.5 transition hover:bg-accent/10 disabled:opacity-30"
              style={{ background: 'var(--surface-elev)' }}
            >◂ Prev</button>
            <span>{clampedPage + 1} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={clampedPage >= totalPages - 1}
              className="rounded-sm [border-color:color-mix(in_oklch,var(--border)_40%,transparent)] border px-2 py-0.5 transition hover:bg-accent/10 disabled:opacity-30"
              style={{ background: 'var(--surface-elev)' }}
            >Next ▸</button>
          </div>
      </div>

      <div className="overflow-hidden rounded-md [border-color:color-mix(in_oklch,var(--border)_40%,transparent)] border" style={{ background: 'color-mix(in oklch, var(--surface-elev) 80%, transparent)' }}>
        {paged.length === 0 ? (
          <div className="py-12 text-center text-sm" style={{ color: 'var(--ink-3)' }}>
            {q ? 'No tasks match your search.' : 'No tasks yet.'}
          </div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b [border-color:color-mix(in_oklch,var(--border)_40%,transparent)]" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 30%, transparent)' }}>
                <th className="py-2.5 pl-4 pr-2 h-section" style={{ width: 32 }}></th>
                <th className="py-2.5 pr-3 h-section">ID</th>
                <th className="py-2.5 pr-3 h-section">Agent</th>
                <th className="py-2.5 pr-3 h-section">Description</th>
                <th className="py-2.5 pr-3 h-section">Duration</th>
                <th className="py-2.5 pr-4 text-right h-section">When</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((task) => (
                <TaskRow key={task.taskId} task={task} onClick={setSelected} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <TaskDetailModal task={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function FindingsPage({
  consensus,
  consensusReports,
}: {
  consensus: import('@/lib/types').ConsensusData;
  consensusReports: import('@/lib/types').ConsensusReportsData | null;
}) {
  const [showRetracted, setShowRetracted] = useState(false);
  const visibleRuns = showRetracted ? consensus.runs : consensus.runs.filter(r => !r.retracted);
  const retractedCount = consensus.runs.filter(r => r.retracted).length;

  const confirmedTotal = visibleRuns.reduce((acc, r) => acc + (r.counts.agreement || 0), 0);
  const disputedTotal = visibleRuns.reduce((acc, r) => acc + ((r.counts.disagreement || 0) + (r.counts.hallucination || 0)), 0);
  const unverifiedTotal = visibleRuns.reduce((acc, r) => acc + (r.counts.unverified || 0), 0);

  return (
    <>
      <div className="mb-6">
        <div className="flex items-baseline gap-3">
          <h1 className="h-route">Consensus Rounds</h1>
          <span className="font-mono text-sm tabular-nums" style={{ color: 'var(--ink-3)' }}>{visibleRuns.length}</span>
          {!showRetracted && retractedCount > 0 && (
            <span className="font-mono text-sm tabular-nums" style={{ color: 'var(--ink-3)' }}>
              / {consensus.totalRuns ?? consensus.runs.length} total
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--ink-3)' }}>Multi-agent review rounds — findings confirmed when ≥2 agents agree.</p>
        <div className="mt-2 flex gap-4 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          <span><span style={{ color: 'var(--ok)' }}>{confirmedTotal}</span> confirmed</span>
          <span><span style={{ color: 'var(--bad)' }}>{disputedTotal}</span> disputed</span>
          {unverifiedTotal > 0 && <span><span className="text-unverified">{unverifiedTotal}</span> unverified</span>}
          <span>{consensus.totalSignals} total signals</span>
        </div>
        {retractedCount > 0 && (
          <div className="mt-2 flex items-center gap-2 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
            <span>
              {showRetracted
                ? `${retractedCount} retracted run${retractedCount === 1 ? '' : 's'} shown`
                : `${retractedCount} retracted run${retractedCount === 1 ? '' : 's'} hidden`}
            </span>
            <button
              type="button"
              onClick={() => setShowRetracted(v => !v)}
              className="rounded-sm [border-color:color-mix(in_oklch,var(--border)_40%,transparent)] border px-2 py-0.5 text-[10px] transition hover:bg-accent/10 hover:[color:var(--ink)]"
              style={{ background: 'var(--surface-elev)' }}
            >
              {showRetracted ? 'hide' : 'show'}
            </button>
          </div>
        )}
      </div>
      <FindingsMetrics consensus={consensus} filteredRuns={visibleRuns} reports={consensusReports} showAll hideHeader />
    </>
  );
}

function Dashboard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const route = useRoute();
  const { overview, agents, tasks, consensus, consensusReports, fleetTrend, signalActivity, skills, loading, error, refresh } = useDashboardData(onUnauthorized);
  const [activeTaskCount, setActiveTaskCount] = useState(0);

  const handleWsEvent = useCallback((event: DashboardEvent) => {
    if (event.type === 'log_lines') return; // handled by LogsPage directly
    refresh();
  }, [refresh]);

  useWebSocket(handleWsEvent);

  // Error state: a core fetch failed (e.g. "overview: HTTP 500"). We still
  // lack gate data, so we can't render the dashboard — but we must NOT keep
  // showing the indefinite spinner. Show the error with a retry hint so the
  // user knows why they're blocked and that recovery is automatic.
  if (!loading && error && (!overview || !consensus)) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
        <TopBar />
        <div className="flex items-center justify-center py-20">
          <div
            className="w-full max-w-sm rounded-xl border p-8 text-center"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-elev)' }}
          >
            <p className="mb-2 text-sm font-semibold" style={{ color: 'var(--bad)' }}>
              Dashboard fetch failed
            </p>
            <p className="mb-4 font-mono text-xs" style={{ color: 'var(--bad)' }}>
              {error}
            </p>
            <p className="text-xs" style={{ color: 'var(--ink-3)' }}>
              Relay may be restarting — retrying every 5s. Check the relay terminal if this persists.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading || !overview || !consensus) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
        <TopBar />
        <OverviewSkeleton />
      </div>
    );
  }

  let content;
  const agentMatch = route.match(/^\/agent\/(.+)$/);
  const consensusFlowMatch = route.match(/^\/consensus\/(.+)$/);
  if (agentMatch && agents) {
    const agentId = decodeURIComponent(agentMatch[1]);
    content = <AgentPage agentId={agentId} agents={agents} tasks={tasks} consensus={consensus} />;
  } else if (consensusFlowMatch) {
    const consensusId = decodeURIComponent(consensusFlowMatch[1]);
    content = <ConsensusFlowPage consensusId={consensusId} />;
  } else if (route === '/team') {
    content = agents
      ? <TeamPage agents={agents} tasks={tasks} consensusReports={consensusReports} fleetTrend={fleetTrend} />
      : (
        <div className="mx-auto max-w-7xl space-y-6 px-6 py-6">
          <TeamPageSkeleton />
        </div>
      );
  } else if (route === '/tasks') {
    content = tasks
      ? <TasksPage tasks={tasks} />
      : (
        <div className="mx-auto max-w-7xl space-y-6 px-6 py-6">
          <TasksPageSkeleton />
        </div>
      );
  } else if (route === '/debates') {
    content = consensus
      ? <FindingsPage consensus={consensus} consensusReports={consensusReports} />
      : (
        <div className="mx-auto max-w-7xl space-y-6 px-6 py-6">
          <DebatesPageSkeleton />
        </div>
      );
  } else if (route === '/logs') {
    content = <LogsPage />;
  } else if (route === '/signals') {
    content = <SignalsPage />;
  } else if (route === '/violations') {
    content = <ViolationsPage />;
  } else {
    // Default: OverviewPage handles `/`, `/overview`, and any unknown route.
    content = (
      <OverviewPage
        overview={overview}
        agents={agents}
        tasks={tasks}
        consensus={consensus}
        consensusReports={consensusReports}
        fleetTrend={fleetTrend}
        signalActivity={signalActivity}
        skills={skills}
        activeTaskCount={activeTaskCount}
        setActiveTaskCount={setActiveTaskCount}
      />
    );
  }

  // Overview owns its own outer container (max-w-5xl). For everything else,
  // the historical max-w-7xl + space-y-6 wrapper applies.
  const isOverview = route === '/' || route === '/overview' ||
    !(/^\/(agent\/|consensus\/|team|tasks|debates|logs|signals|violations)/.test(route));
  const mainClass = isOverview
    ? 'px-6 py-6'
    : 'mx-auto max-w-7xl space-y-6 px-6 py-6';

  return (
    <div className="min-h-screen" style={{ background: 'var(--surface)' }}>
      <TopBar />
      <main className={mainClass}>
        {content}
      </main>
    </div>
  );
}

export function App() {
  const { authed, login, error, recheck } = useAuth();

  if (authed === null) {
    return <div className="flex min-h-screen items-center justify-center" style={{ color: 'var(--ink-3)' }}>Loading...</div>;
  }

  if (!authed) {
    return <AuthGate onLogin={login} error={error} />;
  }

  return (
    <>
      <Dashboard onUnauthorized={recheck} />
      <NotificationStack />
    </>
  );
}
