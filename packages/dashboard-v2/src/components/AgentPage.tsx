import { useState, useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import { NeuralAvatar } from './NeuralAvatar';
import { CategoryStrengths } from './CategoryStrengths';
import { SignalTimeline } from './SignalTimeline';
import { TaskRow } from './TaskRow';
import { agentColor, timeAgo, cleanFindingTags } from '@/lib/utils';
import type { AgentData, TasksData, ConsensusData, MemoryData, MemoryFile } from '@/lib/types';

interface AgentPageProps {
  agentId: string;
  agents: AgentData[];
  tasks: TasksData | null;
  consensus: ConsensusData | null;
}

export function AgentPage({ agentId, agents, tasks, consensus }: AgentPageProps) {
  const agent = agents.find(a => a.id === agentId);
  const [memories, setMemories] = useState<MemoryFile[]>([]);
  const [expandedMem, setExpandedMem] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [runFilter, setRunFilter] = useState<'all' | 'confirmed' | 'disputed' | 'unverified' | 'unique'>('all');
  const [taskPage, setTaskPage] = useState(0);
  const [memDayIdx, setMemDayIdx] = useState(0);

  useEffect(() => {
    api<MemoryData>(`memory/${agentId}`).then(data => {
      setMemories(data.knowledge || []);
    }).catch(() => setMemories([]));
  }, [agentId]);

  if (!agent) {
    return (
      <div className="py-20 text-center text-muted-foreground">Agent not found: {agentId}</div>
    );
  }

  const s = agent.scores;
  const color = agentColor(agent.id);
  const agentTasks = tasks?.items.filter(t => t.agentId === agentId) || [];
  const agentRuns = consensus?.runs.filter(r => r.agents.includes(agentId)) || [];

  const metricBars = [
    { label: 'accuracy', value: s.accuracy, fill: s.accuracy >= 0.7 ? 'bg-confirmed' : s.accuracy >= 0.4 ? 'bg-unverified' : 'bg-disputed' },
    { label: 'reliability', value: s.reliability, fill: 'bg-primary' },
    { label: 'unique', value: s.uniqueness, fill: 'bg-unique' },
    { label: 'impact', value: s.impactScore, fill: 'bg-[var(--color-impact)]' },
  ];

  const compactStats = [
    { label: 'Signals', value: String(s.signals), color: 'text-foreground' },
    { label: 'Agreements', value: String(s.agreements), color: 'text-confirmed' },
    { label: 'Disagreements', value: String(s.disagreements), color: 'text-disputed' },
    { label: 'Hallucinations', value: String(s.hallucinations), color: s.hallucinations > 0 ? 'text-disputed' : 'text-muted-foreground' },
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
      {/* Circuit breaker warning */}
      {s.circuitOpen && (
        <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-destructive">CIRCUIT OPEN</span>
            <span className="text-xs text-destructive/70">
              {s.consecutiveFailures}+ consecutive failures. Agent will be deprioritized until clean signals recorded.
            </span>
          </div>
        </div>
      )}

      {/* Header — v3 card style */}
      <div className="relative mb-6 rounded-xl border border-border bg-gradient-to-br from-card to-card/50 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_2px_8px_rgba(0,0,0,0.35)]">
        <span className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-xl bg-gradient-to-r from-transparent via-white/12 to-transparent" />
        <div className="flex items-center gap-6">
          <div className="relative shrink-0">
            <div className="absolute -inset-3 rounded-full opacity-[0.18] blur-xl" style={{ background: color }} />
            <div className="relative">
              <NeuralAvatar
                agentId={agent.id}
                size={120}
                signals={s.signals}
                accuracy={s.accuracy}
                uniqueness={s.uniqueness}
                impact={s.impactScore}
              />
            </div>
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
              {s.consecutiveFailures > 0 && !s.circuitOpen && (
                <span className="rounded-sm bg-unverified/10 px-2 py-0.5 font-mono text-[10px] font-bold text-unverified">
                  {s.consecutiveFailures} CONSECUTIVE FAILS
                </span>
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
                <div key={m.label} className="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{m.label}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-background/80">
                    <div className={`h-full rounded-full transition-all ${m.fill}`} style={{ width: `${Math.max(0, Math.min(100, m.value * 100))}%` }} />
                  </div>
                  <span className="text-right font-mono text-[11px] font-bold tabular-nums text-foreground">{Math.round(m.value * 100)}%</span>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-5 gap-px overflow-hidden rounded-md border border-border/30 bg-border/30">
              {compactStats.map(st => (
                <div key={st.label} className="bg-background/60 px-2 py-2 text-center">
                  <div className={`font-mono text-sm font-bold tabular-nums ${st.color}`}>{st.value}</div>
                  <div className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">{st.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Category Strengths */}
        <div>
          <h2 className="mb-3 font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
            Category Strengths
          </h2>
          <CategoryStrengths strengths={s.categoryStrengths} />
        </div>
      </section>

      {/* Skills */}
      {(agent.skillSlots.length > 0 || agent.skills.length > 0) && (
        <section className="mb-8">
          <h2 className="mb-3 font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
            Skills <span className="text-primary">{agent.skillSlots.length || agent.skills.length}</span>
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {agent.skillSlots.length > 0 ? agent.skillSlots.map(slot => (
              <span
                key={slot.name}
                className={`rounded-sm border px-2.5 py-1 font-mono text-xs ${
                  !slot.enabled
                    ? 'border-border/50 text-muted-foreground/50 line-through'
                    : slot.mode === 'contextual'
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                    : 'border-border bg-card text-muted-foreground'
                }`}
                title={`${slot.mode} · ${slot.source} · ${slot.enabled ? 'enabled' : 'disabled'}`}
              >
                {slot.mode === 'contextual' && '\u26A1 '}{slot.name}
              </span>
            )) : agent.skills.map(skill => (
              <span key={skill} className="rounded-sm border border-border bg-card px-2.5 py-1 font-mono text-xs text-muted-foreground">
                {skill}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Consensus Participation */}
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
              const isOpen = expandedRun === i;
              const segments = [
                { key: 'confirmed' as const, count: c.agreement || 0, color: 'bg-confirmed', text: 'text-confirmed' },
                { key: 'disputed' as const, count: (c.disagreement || 0) + (c.hallucination || 0), color: 'bg-disputed', text: 'text-disputed' },
                { key: 'unverified' as const, count: c.unverified || 0, color: 'bg-unverified', text: 'text-unverified' },
                { key: 'unique' as const, count: (c.unique || 0) + (c.new || 0), color: 'bg-unique', text: 'text-unique' },
              ];
              const tagMap: Record<string, { label: string; filter: string; cls: string }> = {
                agreement: { label: 'CONFIRMED', filter: 'confirmed', cls: 'text-confirmed bg-confirmed/10' },
                consensus_verified: { label: 'CONFIRMED', filter: 'confirmed', cls: 'text-confirmed bg-confirmed/10' },
                disagreement: { label: 'DISPUTED', filter: 'disputed', cls: 'text-disputed bg-disputed/10' },
                hallucination_caught: { label: 'DISPUTED', filter: 'disputed', cls: 'text-disputed bg-disputed/10' },
                unverified: { label: 'UNVERIFIED', filter: 'unverified', cls: 'text-unverified bg-unverified/10' },
                unique_confirmed: { label: 'UNIQUE', filter: 'unique', cls: 'text-unique bg-unique/10' },
                unique_unconfirmed: { label: 'UNIQUE', filter: 'unique', cls: 'text-unique bg-unique/10' },
                new_finding: { label: 'NEW', filter: 'unique', cls: 'text-unique bg-unique/10' },
              };
              const filteredSignals = run.signals.filter(sig => {
                if (sig.signal === 'signal_retracted') return false;
                const tag = tagMap[sig.signal];
                if (!tag) return false;
                return runFilter === 'all' || tag.filter === runFilter;
              });
              return (
                <div key={run.taskId + i} className={`rounded-md border bg-card transition ${isOpen ? 'border-primary/25' : 'border-border/40'}`}>
                  <button
                    onClick={() => { setExpandedRun(isOpen ? null : i); setRunFilter('all'); }}
                    className="flex w-full items-center p-3 text-left transition hover:bg-accent/50"
                  >
                    <span className={`mr-3 font-mono text-xs ${isOpen ? 'text-primary' : 'text-muted-foreground'}`}>{isOpen ? '\u25BE' : '\u25B8'}</span>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-semibold text-foreground">{total} findings</span>
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
                  {isOpen && (
                    <div className="border-t border-border px-4 pb-3 pt-3">
                      {/* Filter chips are neutral. They used to echo the
                          finding colors (confirmed/disputed/unverified/unique),
                          which collided visually with the actual count chips
                          above — users couldn't tell "filter for disputed"
                          from "there were 3 disputed findings". Matching the
                          LogsPage filter pattern for consistency. */}
                      <div className="mb-3 flex gap-1.5">
                        {(['all', 'confirmed', 'disputed', 'unverified', 'unique'] as const).map(f => (
                          <button
                            key={f}
                            onClick={() => setRunFilter(f)}
                            className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-semibold transition ${
                              runFilter === f
                                ? 'text-foreground bg-muted'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {f.charAt(0).toUpperCase() + f.slice(1)}
                          </button>
                        ))}
                      </div>
                      {filteredSignals.length === 0 ? (
                        <div className="py-3 text-center text-xs text-muted-foreground">No findings match this filter.</div>
                      ) : (
                        <div className="space-y-1.5">
                          {filteredSignals.map((sig, j) => {
                            const tag = tagMap[sig.signal];
                            if (!tag) return null;
                            return (
                              <div key={j} className="flex items-start gap-2">
                                <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold ${tag.cls}`}>{tag.label}</span>
                                <div className="min-w-0 flex-1">
                                  <span className="text-xs text-muted-foreground [&_.cite-file]:rounded [&_.cite-file]:bg-blue-500/10 [&_.cite-file]:px-1 [&_.cite-file]:font-mono [&_.cite-file]:text-blue-400 [&_.cite-fn]:rounded [&_.cite-fn]:bg-purple-500/10 [&_.cite-fn]:px-1 [&_.cite-fn]:font-mono [&_.cite-fn]:text-purple-400" dangerouslySetInnerHTML={{ __html: cleanFindingTags(sig.evidence || '') }} />
                                  <span className="ml-2 font-mono text-[10px] text-muted-foreground/50">
                                    {sig.agentId}{sig.counterpartId ? ` + ${sig.counterpartId}` : ''}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
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
