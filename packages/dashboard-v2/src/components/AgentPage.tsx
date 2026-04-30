import { useState, useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import { NeuralAvatar } from './NeuralAvatar';
import { CategoryCompetency } from './CategoryCompetency';
import { SkillCard } from './SkillCard';
import { AgentActivityTimeline } from './AgentActivityTimeline';
import { FindingDetailDrawer } from './FindingDetailDrawer';
import { SignalTimeline } from './SignalTimeline';
import { TaskRow } from './TaskRow';
import { timeAgo, renderFindingMarkdown } from '@/lib/utils';
import { getBenchBadgeKind } from '@/lib/bench';
import { escapeHtml } from '@/lib/sanitize';
import type { AgentData, TasksData, ConsensusData, ConsensusReport, ConsensusReportsData, MemoryData, MemoryFile, ParseDiagnostic } from '@/lib/types';

interface AgentPageProps {
  agentId: string;
  agents: AgentData[];
  tasks: TasksData | null;
  consensus: ConsensusData | null;
}

/** Persistent-banner threshold. Agent detail page shows the banner when the
 * same diagnostic code has fired at least this many times for this agent in
 * the trailing 30d window. Matches the spec threshold (≥3 / 30d). */
const DIAGNOSTIC_BANNER_THRESHOLD = 3;
const DIAGNOSTIC_BANNER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function AgentPage({ agentId, agents, tasks, consensus }: AgentPageProps) {
  const agent = agents.find(a => a.id === agentId);
  const [memories, setMemories] = useState<MemoryFile[]>([]);
  const [reports, setReports] = useState<ConsensusReport[]>([]);
  const [expandedMem, setExpandedMem] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [drawerFinding, setDrawerFinding] = useState<{ consensusId: string; findingId: string } | null>(null);
  const [taskPage, setTaskPage] = useState(0);
  const [memDayIdx, setMemDayIdx] = useState(0);

  useEffect(() => {
    api<MemoryData>(`memory/${agentId}`).then(data => {
      setMemories(data.knowledge || []);
    }).catch(() => setMemories([]));
  }, [agentId]);

  // Fetch consensus reports to compute per-agent diagnostic frequency.
  // Uses the same pagination the FindingsMetrics "view all" path uses; page
  // size of 200 covers the 30d window on any realistic project size.
  useEffect(() => {
    let cancelled = false;
    api<ConsensusReportsData>('consensus-reports?page=1&pageSize=200')
      .then(data => {
        if (!cancelled) setReports(data.reports || []);
      })
      .catch(() => { if (!cancelled) setReports([]); });
    return () => { cancelled = true; };
  }, []);

  // Roll up diagnostic code → count (within 30d) for THIS agent, across all
  // reports where they appeared in authorDiagnostics. The banner fires when
  // any code crosses DIAGNOSTIC_BANNER_THRESHOLD.
  const diagnosticBanner = useMemo(() => {
    const now = Date.now();
    const counts = new Map<ParseDiagnostic['code'], number>();
    for (const r of reports) {
      const ts = Date.parse(r.timestamp);
      if (Number.isNaN(ts) || now - ts > DIAGNOSTIC_BANNER_WINDOW_MS) continue;
      const diags = r.authorDiagnostics?.[agentId];
      if (!diags) continue;
      for (const d of diags) counts.set(d.code, (counts.get(d.code) ?? 0) + 1);
    }
    const fired: Array<{ code: ParseDiagnostic['code']; count: number }> = [];
    for (const [code, count] of counts) {
      if (count >= DIAGNOSTIC_BANNER_THRESHOLD) fired.push({ code, count });
    }
    return fired;
  }, [reports, agentId]);

  if (!agent) {
    return (
      <div className="py-20 text-center text-muted-foreground">Agent not found: {agentId}</div>
    );
  }

  const s = agent.scores;
  const agentTasks = tasks?.items.filter(t => t.agentId === agentId) || [];
  const agentRuns = consensus?.runs.filter(r => r.agents.includes(agentId)) || [];

  const metricBars = [
    { label: 'accuracy', value: s.accuracy, fill: s.accuracy >= 0.7 ? 'bg-confirmed' : s.accuracy >= 0.4 ? 'bg-unverified' : 'bg-disputed' },
    { label: 'reliability', value: s.reliability, fill: 'bg-chart', tooltip: 'Task completion rate — fraction of dispatched tasks that finished without pipeline error or timeout' },
    { label: 'unique', value: s.uniqueness, fill: 'bg-unique' },
    { label: 'impact', value: s.impactScore, fill: 'bg-[var(--color-impact)]' },
  ];

  // Unverified signals carry two meanings depending on whose column they land in:
  // - emitted: this agent was the reviewer saying "I can't verify this"
  // - received: this agent's findings were un-verifiable by peers (often bad/missing citations)
  // Both are signals of friction, not fault, so we render them muted-amber — neither
  // green like agreements nor red like hallucinations.
  const unvEmitted = s.unverifiedsEmitted ?? 0;
  const unvReceived = s.unverifiedsReceived ?? 0;
  const unvTotal = unvEmitted + unvReceived;

  const compactStats = [
    { label: 'Signals', value: String(s.signals), color: 'text-foreground' },
    { label: 'Agreements', value: String(s.agreements), color: 'text-confirmed' },
    { label: 'Disagreements', value: String(s.disagreements), color: 'text-disputed' },
    { label: 'Hallucinations', value: String(s.hallucinations), color: s.hallucinations > 0 ? 'text-disputed' : 'text-muted-foreground' },
    {
      label: 'Unverified',
      value: unvTotal > 0 ? `${unvEmitted}↑ ${unvReceived}↓` : '0',
      color: unvTotal > 0 ? 'text-unverified' : 'text-muted-foreground',
      title: unvTotal > 0 ? `${unvEmitted} emitted (as reviewer) · ${unvReceived} received (as author)` : undefined,
    },
    { label: 'Tokens', value: agent.totalTokens.toLocaleString(), color: 'text-foreground' },
  ];

  // Paginate tasks by 10
  const TASKS_PER_PAGE = 10;
  const taskPages = Math.max(1, Math.ceil(agentTasks.length / TASKS_PER_PAGE));
  const clampedTaskPage = Math.min(taskPage, taskPages - 1);
  const pagedTasks = agentTasks.slice(clampedTaskPage * TASKS_PER_PAGE, (clampedTaskPage + 1) * TASKS_PER_PAGE);

  // Group memories by day (extract YYYY-MM-DD from filename prefix, fall back to "undated")
  const memoryDays = useMemo(() => {
    const groups = new Map<string, MemoryFile[]>();
    for (const mem of memories) {
      const match = mem.filename.match(/^(\d{4}-\d{2}-\d{2})/);
      const day = match ? match[1] : 'undated';
      const arr = groups.get(day) || [];
      arr.push(mem);
      groups.set(day, arr);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => (a === 'undated' ? 1 : b === 'undated' ? -1 : b.localeCompare(a)))
      .map(([day, items]) => ({ day, items }));
  }, [memories]);
  const clampedMemDayIdx = Math.min(memDayIdx, Math.max(0, memoryDays.length - 1));
  const currentDay = memoryDays[clampedMemDayIdx];

  return (
    <>
      {/* Bench / circuit breaker warning — three-state panel */}
      {(() => {
        const kind = getBenchBadgeKind(s);
        if (kind === 'benched') return (
          <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-destructive">BENCHED</span>
              <span className="text-xs text-destructive/70">
                Auto-bench rule fired ({s.bench.reason ?? 'unknown'}). Agent excluded from dispatch until scores recover.
              </span>
            </div>
          </div>
        );
        if (kind === 'struggling') return (
          <div className="mb-6 rounded-lg border border-unverified/30 bg-unverified/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-unverified">STRUGGLING</span>
              <span className="text-xs text-unverified/70">
                {s.consecutiveFailures}+ consecutive failures. Deprioritized until clean signals recorded.
              </span>
            </div>
          </div>
        );
        if (kind === 'kept-for-coverage') return (
          <div className="mb-6 rounded-lg border border-unverified/30 bg-unverified/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-unverified">KEPT FOR COVERAGE</span>
              <span className="text-xs text-unverified/70">
                Would be benched ({s.bench.reason ?? 'rule'}), but is the sole provider of a category — kept to preserve coverage.
              </span>
            </div>
          </div>
        );
        return null;
      })()}

      {/* Persistent parse-diagnostic banner — fires when the same diagnostic
          code has tripped at least DIAGNOSTIC_BANNER_THRESHOLD times in the
          trailing 30d window for this agent. Distinct from the one-off
          per-finding banner on the consensus card: this tracks a pattern, so
          the operator knows the agent's pipeline (not just one round) is
          producing unparseable output. */}
      {diagnosticBanner.length > 0 && (
        <div className="mb-6 space-y-2">
          {diagnosticBanner.map(({ code, count }) => (
            <div
              key={code}
              className="rounded-lg border border-unverified/30 bg-unverified/5 px-4 py-3"
              data-diagnostic-code={code}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold text-unverified">PARSE DIAGNOSTIC</span>
                <span
                  className="font-mono text-[11px] text-unverified/80"
                  dangerouslySetInnerHTML={{ __html: escapeHtml(code) }}
                />
                <span className="font-mono text-[11px] text-unverified/60">
                  · {count} fires in 30d
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground/80">
                This agent's raw output has repeatedly tripped <span className="font-mono">{code}</span>.
                Inspect recent consensus rounds on this page for the per-finding banner, or check
                upstream pipeline layers (sanitizer / renderer / relay encoding).
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Header — flattened: dropped the gradient layer, inset highlight line,
          and per-agent halo glow. The glow was hex-derived so the header tone
          changed per agent in a way that was decorative, not informational. */}
      <div className="relative mb-6 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-6">
          <div className="relative shrink-0">
            <NeuralAvatar
              agentId={agent.id}
              size={120}
              signals={s.signals}
              accuracy={s.accuracy}
              uniqueness={s.uniqueness}
              impact={s.impactScore}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-mono text-2xl font-bold text-foreground">{agent.id}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{agent.provider}/{agent.model}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-semibold ${agent.native ? 'text-primary bg-primary/10' : 'text-confirmed bg-confirmed/10'}`}>
                {agent.native ? 'NATIVE' : 'RELAY'}
              </span>
              {agent.preset && (
                <span className="rounded-sm bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{agent.preset}</span>
              )}
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {s.signals} signals{agent.lastTask ? ` · ${timeAgo(agent.lastTask.timestamp)}` : ''}
              </span>
            </div>
          </div>
          <div
            className="flex shrink-0 flex-col items-end rounded-md border border-border bg-background/60 px-3 py-2"
            data-tooltip={`Dispatch weight ${s.dispatchWeight.toFixed(2)}\nScale 0.3 → 2.0`}
            data-tooltip-pos="left"
          >
            <span className="font-mono text-2xl font-bold tabular-nums leading-none text-foreground">
              {s.dispatchWeight.toFixed(2)}
            </span>
            <span className="mt-1 font-mono text-[9px] uppercase text-muted-foreground/50">weight</span>
          </div>
        </div>
      </div>

      {/* Signal Timeline */}
      <section className="mb-6">
        <SignalTimeline agentId={agentId} />
      </section>

      {/* Two-column: Metrics + Category Strengths */}
      <section className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: Metrics — bars + compact stat strip */}
        <div>
          <h2 className="mb-3 font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">Metrics</h2>
          <div className="rounded-lg border border-border/40 bg-card/80 p-4 shadow-[inset_0_1px_3px_rgba(0,0,0,0.35)]">
            <div className="space-y-2.5">
              {metricBars.map(m => (
                <div key={m.label} className="grid grid-cols-[72px_1fr_44px] items-center gap-3" {...(m.tooltip ? { 'data-tooltip': m.tooltip } : {})}>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{m.label}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-background/80">
                    <div className={`h-full rounded-full transition-all ${m.fill}`} style={{ width: `${Math.max(0, Math.min(100, m.value * 100))}%` }} />
                  </div>
                  <span className="text-right font-mono text-[11px] font-bold tabular-nums text-foreground">{Math.round(m.value * 100)}%</span>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-6 gap-px overflow-hidden rounded-md border border-border/30 bg-border/30">
              {compactStats.map(st => (
                <div
                  key={st.label}
                  className="bg-background/60 px-2 py-2 text-center"
                  title={(st as { title?: string }).title}
                >
                  <div className={`font-mono text-sm font-bold tabular-nums ${st.color}`}>{st.value}</div>
                  <div className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">{st.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Category Competency — accuracy-first horizontal bars. The
            legacy CategoryStrengths (severity-weighted sort + sparse rows) is
            retained for reference but we lead with the ratio view here. */}
        <div>
          <h2 className="mb-1 font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
            Category Competency
          </h2>
          <p className="mb-3 mt-0.5 font-mono text-[10px] text-muted-foreground/60">Raw per-category ratio — unweighted. Overall accuracy in Metrics applies a hallucination penalty.</p>
          <CategoryCompetency
            categoryAccuracy={s.categoryAccuracy}
            categoryCorrect={s.categoryCorrect}
            categoryHallucinated={s.categoryHallucinated}
          />
        </div>
      </section>

      {/* Skills — rich card view with effectiveness, status, strikes, forced-develop history. */}
      {(agent.skillSlots.length > 0 || agent.skills.length > 0) && (
        <section className="mb-8">
          <h2 className="mb-3 font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
            Skills <span className="text-primary">{agent.skillSlots.length || agent.skills.length}</span>
          </h2>
          {agent.skillSlots.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {agent.skillSlots.map(slot => (
                <SkillCard key={slot.name} slot={slot} />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {agent.skills.map(skill => (
                <span key={skill} className="rounded-sm border border-border bg-card px-2.5 py-1 font-mono text-xs text-muted-foreground">
                  {skill}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Consensus Participation — per-finding rows open the shared
          FindingDetailDrawer (PR-F). The legacy inline accordion made users
          scroll several screens to see one finding's citation + signals; the
          drawer surfaces both in one click. */}
      <section className="mb-8">
        <h2 className="mb-3 font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
          Consensus Runs <span className="text-primary">{agentRuns.length}</span>
        </h2>
        {agentRuns.length > 0 ? (
          <div className="space-y-2">
            {agentRuns.slice(0, 20).map((run, i) => {
              const c = run.counts;
              const total = (c.agreement || 0) + (c.disagreement || 0) + (c.hallucination || 0) + (c.unverified || 0) + (c.unique || 0) + (c.new || 0);
              const barTotal = total || 1;
              const segments = [
                { key: 'confirmed' as const, count: c.agreement || 0, color: 'bg-confirmed', text: 'text-confirmed' },
                { key: 'disputed' as const, count: (c.disagreement || 0) + (c.hallucination || 0), color: 'bg-disputed', text: 'text-disputed' },
                { key: 'unverified' as const, count: c.unverified || 0, color: 'bg-unverified', text: 'text-unverified' },
                { key: 'unique' as const, count: (c.unique || 0) + (c.new || 0), color: 'bg-unique', text: 'text-unique' },
              ];
              const tagMap: Record<string, { label: string; cls: string }> = {
                agreement: { label: 'CONFIRMED', cls: 'text-confirmed bg-confirmed/10' },
                consensus_verified: { label: 'CONFIRMED', cls: 'text-confirmed bg-confirmed/10' },
                disagreement: { label: 'DISPUTED', cls: 'text-disputed bg-disputed/10' },
                hallucination_caught: { label: 'DISPUTED', cls: 'text-disputed bg-disputed/10' },
                unverified: { label: 'UNVERIFIED', cls: 'text-unverified bg-unverified/10' },
                unique_confirmed: { label: 'UNIQUE', cls: 'text-unique bg-unique/10' },
                unique_unconfirmed: { label: 'UNIQUE', cls: 'text-unique bg-unique/10' },
                new_finding: { label: 'NEW', cls: 'text-unique bg-unique/10' },
              };
              const runSignals = run.signals.filter(sig => sig.signal !== 'signal_retracted' && tagMap[sig.signal]);
              const runKey = run.taskId + ':' + i;
              const isOpen = expandedRun === runKey;
              return (
                <div key={runKey} className="rounded-md border border-border/40 bg-card">
                  <button
                    type="button"
                    onClick={() => setExpandedRun(isOpen ? null : runKey)}
                    disabled={runSignals.length === 0}
                    className={`flex w-full items-center p-3 text-left transition ${runSignals.length > 0 ? 'hover:bg-accent/20' : 'cursor-default'}`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-semibold text-foreground">
                          {runSignals.length > 0 && (
                            <span className="mr-1.5 inline-block text-muted-foreground">{isOpen ? '▾' : '▸'}</span>
                          )}
                          {total} findings
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">{timeAgo(run.timestamp)}</span>
                      </div>
                      <div className="mt-1.5 flex gap-2">
                        {segments.map(seg => seg.count > 0 && (
                          <span key={seg.key} className={`font-mono text-[10px] font-semibold ${seg.text}`}>{seg.count} {seg.key}</span>
                        ))}
                      </div>
                      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-sm">
                        {segments.map(seg => seg.count > 0 && (
                          <div key={seg.key} className={seg.color} style={{ width: `${(seg.count / barTotal) * 100}%` }} />
                        ))}
                      </div>
                    </div>
                  </button>
                  {isOpen && runSignals.length > 0 && (
                    <div className="border-t border-border/30 px-3 pb-2 pt-2">
                      <div className="space-y-1">
                        {runSignals.map((sig, j) => {
                          const tag = tagMap[sig.signal];
                          const clickable = !!(sig.findingId && run.taskId);
                          // run.taskId is the consensusId on the agent-page shape.
                          const row = (
                            <div className="flex items-start gap-2 py-1">
                              <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold ${tag.cls}`}>{tag.label}</span>
                              <div className="min-w-0 flex-1">
                                <span className="finding-md text-xs text-muted-foreground [&_.cite-file]:rounded [&_.cite-file]:bg-blue-500/10 [&_.cite-file]:px-1 [&_.cite-file]:font-mono [&_.cite-file]:text-blue-400 [&_.cite-fn]:rounded [&_.cite-fn]:bg-purple-500/10 [&_.cite-fn]:px-1 [&_.cite-fn]:font-mono [&_.cite-fn]:text-purple-400" dangerouslySetInnerHTML={{ __html: renderFindingMarkdown(sig.evidence || '') }} />
                                <span className="ml-2 font-mono text-[10px] text-muted-foreground/50">
                                  {sig.agentId}{sig.counterpartId ? ` + ${sig.counterpartId}` : ''}
                                </span>
                              </div>
                            </div>
                          );
                          if (clickable) {
                            return (
                              <button
                                key={j}
                                type="button"
                                onClick={() => setDrawerFinding({ consensusId: run.taskId, findingId: sig.findingId! })}
                                className="block w-full rounded-sm text-left transition hover:bg-accent/40"
                              >{row}</button>
                            );
                          }
                          return <div key={j}>{row}</div>;
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">No consensus participation recorded.</div>
        )}
      </section>

      {/* Activity feed — reverse-chronological signals (+ tasks/skills later) */}
      <section className="mb-8">
        <AgentActivityTimeline agentId={agentId} />
      </section>

      <FindingDetailDrawer
        open={!!drawerFinding}
        onOpenChange={(open) => { if (!open) setDrawerFinding(null); }}
        consensusId={drawerFinding?.consensusId ?? null}
        findingId={drawerFinding?.findingId ?? null}
      />

      {/* Tasks */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
            Tasks <span className="text-primary">{agentTasks.length}</span>
          </h2>
          {taskPages > 1 && (
            <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
              <button
                onClick={() => setTaskPage(p => Math.max(0, p - 1))}
                disabled={clampedTaskPage === 0}
                className="rounded-sm border border-border/40 bg-card px-2 py-0.5 transition hover:bg-accent/50 disabled:opacity-30"
              >◂ Prev</button>
              <span>{clampedTaskPage + 1} / {taskPages}</span>
              <button
                onClick={() => setTaskPage(p => Math.min(taskPages - 1, p + 1))}
                disabled={clampedTaskPage >= taskPages - 1}
                className="rounded-sm border border-border/40 bg-card px-2 py-0.5 transition hover:bg-accent/50 disabled:opacity-30"
              >Next ▸</button>
            </div>
          )}
        </div>
        {agentTasks.length > 0 ? (
          <div className="overflow-hidden rounded-md border border-border/40">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-card">
                  <th className="py-2 pl-4 pr-2 text-xs font-medium text-muted-foreground" style={{ width: 32 }}></th>
                  <th className="py-2 pr-3 font-mono text-xs font-medium text-muted-foreground">ID</th>
                  <th className="py-2 pr-3 font-mono text-xs font-medium text-muted-foreground">Agent</th>
                  <th className="py-2 pr-3 text-xs font-medium text-muted-foreground">Description</th>
                  <th className="py-2 pr-3 font-mono text-xs font-medium text-muted-foreground">Duration</th>
                  <th className="py-2 pr-4 text-right font-mono text-xs font-medium text-muted-foreground">When</th>
                </tr>
              </thead>
              <tbody>
                {pagedTasks.map(task => (
                  <TaskRow key={task.taskId} task={task} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">No tasks recorded.</div>
        )}
      </section>

      {/* Memory Files — paginated by day */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
            Memory <span className="text-primary">{memories.length} files</span>
            {currentDay && (
              <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                · {currentDay.day} ({currentDay.items.length})
              </span>
            )}
          </h2>
          {memoryDays.length > 1 && (
            <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
              <button
                onClick={() => setMemDayIdx(i => Math.max(0, i - 1))}
                disabled={clampedMemDayIdx === 0}
                className="rounded-sm border border-border/40 bg-card px-2 py-0.5 transition hover:bg-accent/50 disabled:opacity-30"
              >◂ Newer</button>
              <span>{clampedMemDayIdx + 1} / {memoryDays.length}</span>
              <button
                onClick={() => setMemDayIdx(i => Math.min(memoryDays.length - 1, i + 1))}
                disabled={clampedMemDayIdx >= memoryDays.length - 1}
                className="rounded-sm border border-border/40 bg-card px-2 py-0.5 transition hover:bg-accent/50 disabled:opacity-30"
              >Older ▸</button>
            </div>
          )}
        </div>
        {currentDay && currentDay.items.length > 0 ? (
          <div className="space-y-1.5">
            {currentDay.items.map(mem => {
              const isOpen = expandedMem === mem.filename;
              const type = mem.frontmatter?.type || 'memory';
              const name = mem.frontmatter?.name || mem.filename.replace(/\.md$/, '');
              return (
                <div key={mem.filename} className="rounded-md border border-border/40 bg-card/80">
                  <button
                    onClick={() => setExpandedMem(isOpen ? null : mem.filename)}
                    className="flex w-full items-center gap-2 p-3 text-left transition hover:bg-accent/50"
                  >
                    <span className={`font-mono text-xs ${isOpen ? 'text-primary' : 'text-muted-foreground'}`}>
                      {isOpen ? '\u25BE' : '\u25B8'}
                    </span>
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-muted-foreground">
                      {type}
                    </span>
                    <span className="truncate font-mono text-xs font-semibold text-foreground">{name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{mem.filename}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border px-4 py-3">
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
                        {mem.content}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">No memory files.</div>
        )}
      </section>
    </>
  );
}
