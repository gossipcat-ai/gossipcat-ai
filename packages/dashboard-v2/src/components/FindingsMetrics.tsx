import { useState } from 'react';
import type { ConsensusData, ConsensusReportsData, ConsensusReportFinding } from '@/lib/types';
import { timeAgo, cleanFindingTags } from '@/lib/utils';

interface FindingsMetricsProps {
  consensus: ConsensusData;
  reports?: ConsensusReportsData | null;
}

const MAX_RUNS = 5;

type FilterType = 'all' | 'confirmed' | 'disputed' | 'unverified' | 'unique';

const TAG_MAP: Record<string, { label: string; filter: FilterType; cls: string }> = {
  agreement: { label: 'CONFIRMED', filter: 'confirmed', cls: 'text-confirmed bg-confirmed/10' },
  consensus_verified: { label: 'CONFIRMED', filter: 'confirmed', cls: 'text-confirmed bg-confirmed/10' },
  disagreement: { label: 'DISPUTED', filter: 'disputed', cls: 'text-disputed bg-disputed/10' },
  hallucination_caught: { label: 'DISPUTED', filter: 'disputed', cls: 'text-disputed bg-disputed/10' },
  unverified: { label: 'UNVERIFIED', filter: 'unverified', cls: 'text-unverified bg-unverified/10' },
  unique_confirmed: { label: 'UNIQUE', filter: 'unique', cls: 'text-unique bg-unique/10' },
  unique_unconfirmed: { label: 'UNIQUE', filter: 'unique', cls: 'text-unique bg-unique/10' },
  new_finding: { label: 'NEW', filter: 'unique', cls: 'text-unique bg-unique/10' },
};

const FILTER_CHIPS: { key: FilterType; label: string; cls: string; activeCls: string }[] = [
  { key: 'all', label: 'All', cls: 'text-muted-foreground', activeCls: 'text-foreground bg-muted' },
  { key: 'confirmed', label: 'Confirmed', cls: 'text-confirmed/60', activeCls: 'text-confirmed bg-confirmed/10' },
  { key: 'disputed', label: 'Disputed', cls: 'text-disputed/60', activeCls: 'text-disputed bg-disputed/10' },
  { key: 'unverified', label: 'Unverified', cls: 'text-unverified/60', activeCls: 'text-unverified bg-unverified/10' },
  { key: 'unique', label: 'Unique', cls: 'text-unique/60', activeCls: 'text-unique bg-unique/10' },
];

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-red-400 bg-red-500/10',
  high: 'text-orange-400 bg-orange-500/10',
  medium: 'text-yellow-400 bg-yellow-500/10',
  low: 'text-muted-foreground bg-muted/50',
};

function ReportFinding({ f }: { f: ConsensusReportFinding }) {
  const tagCls = f.tag === 'confirmed' ? 'text-confirmed bg-confirmed/10'
    : f.tag === 'disputed' ? 'text-disputed bg-disputed/10'
    : f.tag === 'unverified' ? 'text-unverified bg-unverified/10'
    : 'text-unique bg-unique/10';
  const sevCls = f.severity ? SEVERITY_CLS[f.severity] || '' : '';
  return (
    <div className="flex items-start gap-2">
      <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold ${tagCls}`}>
        {f.tag.toUpperCase()}
      </span>
      {f.severity && (
        <span className={`shrink-0 rounded-sm px-1 py-0.5 font-mono text-[8px] font-bold ${sevCls}`}>
          {f.severity.toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <span className="text-xs text-muted-foreground [&_.cite-file]:rounded [&_.cite-file]:bg-blue-500/10 [&_.cite-file]:px-1 [&_.cite-file]:font-mono [&_.cite-file]:text-blue-400 [&_.cite-fn]:rounded [&_.cite-fn]:bg-purple-500/10 [&_.cite-fn]:px-1 [&_.cite-fn]:font-mono [&_.cite-fn]:text-purple-400"
          dangerouslySetInnerHTML={{ __html: cleanFindingTags(f.finding) }} />
        <span className="ml-2 font-mono text-[10px] text-muted-foreground/50">{f.originalAgentId}</span>
      </div>
    </div>
  );
}

export function FindingsMetrics({ consensus, reports }: FindingsMetricsProps) {
  const runs = consensus.runs.slice(0, MAX_RUNS);
  const hasMore = consensus.runs.length > MAX_RUNS;
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');

  // If we have structured reports, show those instead of signal-based view
  const latestReports = reports?.reports?.slice(0, MAX_RUNS) || [];

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Consensus Rounds <span className="text-primary">{consensus.runs.length}</span>
        </h2>
        {hasMore && (
          <a href="#/findings" className="font-mono text-xs text-muted-foreground transition hover:text-primary">
            view all →
          </a>
        )}
      </div>

      {latestReports.length > 0 ? (
        <div className="space-y-2">
          {latestReports.map((report, i) => {
            const allFindings = [
              ...report.confirmed,
              ...report.disputed,
              ...report.unverified,
              ...report.unique,
              ...(report.insights || []),
            ];
            const filteredFindings = filter === 'all' ? allFindings
              : allFindings.filter(f => f.tag === filter || (filter === 'unique' && f.findingType === 'insight'));
            const isExpanded = expandedIdx === i;

            return (
              <div key={report.id} className="rounded-md border border-border/50 bg-card/50 px-3 py-2">
                <button className="flex w-full items-center justify-between text-left" onClick={() => setExpandedIdx(isExpanded ? null : i)}>
                  <div>
                    <span className="font-mono text-[10px] text-primary/70">{report.id}</span>
                    <span className="ml-2 font-mono text-sm font-bold text-foreground">{allFindings.length} findings</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {report.agentCount} agents · {report.rounds} rounds
                    </span>
                    <div className="mt-0.5">
                      {report.confirmed.length > 0 && <span className="text-[10px] font-bold text-confirmed">{report.confirmed.length} confirmed </span>}
                      {report.disputed.length > 0 && <span className="text-[10px] font-bold text-disputed">{report.disputed.length} disputed </span>}
                      {report.unverified.length > 0 && <span className="text-[10px] font-bold text-unverified">{report.unverified.length} unverified </span>}
                      {report.unique.length > 0 && <span className="text-[10px] font-bold text-unique">{report.unique.length} unique </span>}
                      {(report.insights || []).length > 0 && <span className="text-[10px] font-bold text-purple-400">{report.insights.length} insights </span>}
                    </div>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">{timeAgo(report.timestamp)}</span>
                </button>
                {isExpanded && (
                  <div className="mt-3 border-t border-border/30 pt-3">
                    <div className="mb-2 flex gap-2">
                      {FILTER_TABS.map(tab => (
                        <button key={tab.key} onClick={() => setFilter(tab.key)}
                          className={`font-mono text-[10px] ${filter === tab.key ? tab.activeCls : tab.cls}`}>
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <div className="space-y-1.5">
                      {filteredFindings.length === 0 ? (
                        <div className="py-4 text-center text-xs text-muted-foreground">No findings match this filter.</div>
                      ) : (
                        filteredFindings.map((f, j) => <ReportFinding key={j} f={f} />)
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : runs.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No consensus runs yet.</div>
      ) : (
        <div className="space-y-2">
          {runs.map((run, i) => {
            const c = run.counts;
            const runTotal = (c.agreement || 0) + (c.disagreement || 0) + (c.hallucination || 0) + (c.unverified || 0) + (c.unique || 0) + (c.new || 0);
            const barTotal = runTotal || 1;
            const isOpen = expandedIdx === i;

            const segments = [
              { key: 'confirmed', count: c.agreement || 0, color: 'bg-confirmed', text: 'text-confirmed', label: 'confirmed' },
              { key: 'disputed', count: (c.disagreement || 0) + (c.hallucination || 0), color: 'bg-disputed', text: 'text-disputed', label: 'disputed' },
              { key: 'unverified', count: c.unverified || 0, color: 'bg-unverified', text: 'text-unverified', label: 'unverified' },
              { key: 'unique', count: (c.unique || 0) + (c.new || 0), color: 'bg-unique', text: 'text-unique', label: 'unique' },
            ];

            // Filter signals for expanded view
            const filteredSignals = run.signals.filter(sig => {
              if (sig.signal === 'signal_retracted') return false;
              if (filter === 'all') return !!TAG_MAP[sig.signal];
              const tag = TAG_MAP[sig.signal];
              return tag && tag.filter === filter;
            });

            return (
              <div key={run.taskId + i} className={`rounded-md border bg-card transition ${isOpen ? 'border-primary/25' : 'border-border'}`}>
                {/* Header — clickable */}
                <button
                  onClick={() => setExpandedIdx(isOpen ? null : i)}
                  className="flex w-full items-center p-3 text-left transition hover:bg-accent/50"
                >
                  <span className={`mr-3 font-mono text-xs text-muted-foreground transition ${isOpen ? 'text-primary' : ''}`}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[10px] text-primary/50">{run.taskId.slice(0, 17)}</span>
                        <span className="font-mono text-sm font-semibold text-foreground">{runTotal} findings</span>
                        <div className="flex gap-1.5">
                          {run.agents.slice(0, 4).map((a) => (
                            <span key={a} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                              {a.split('-').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                            </span>
                          ))}
                          {run.agents.length > 4 && (
                            <span className="font-mono text-[10px] text-muted-foreground">+{run.agents.length - 4}</span>
                          )}
                        </div>
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{timeAgo(run.timestamp)}</span>
                    </div>

                    <div className="mt-2 flex gap-2">
                      {segments.map((s) => s.count > 0 && (
                        <span key={s.key} className={`font-mono text-[10px] font-semibold ${s.text}`}>
                          {s.count} {s.label}
                        </span>
                      ))}
                    </div>

                    <div className="mt-2 flex h-1.5 overflow-hidden rounded-sm">
                      {segments.map((s) => s.count > 0 && (
                        <div key={s.key} className={`${s.color} transition-all`} style={{ width: `${(s.count / barTotal) * 100}%` }} />
                      ))}
                    </div>
                  </div>
                </button>

                {/* Expanded findings */}
                {isOpen && (
                  <div className="border-t border-border px-4 pb-3 pt-3">
                    {/* Filter chips */}
                    <div className="mb-3 flex gap-1.5">
                      {FILTER_CHIPS.map((chip) => (
                        <button
                          key={chip.key}
                          onClick={() => setFilter(chip.key)}
                          className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-semibold transition ${filter === chip.key ? chip.activeCls : chip.cls} hover:opacity-80`}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>

                    {/* Findings list */}
                    {filteredSignals.length === 0 ? (
                      <div className="py-4 text-center text-xs text-muted-foreground">No findings match this filter.</div>
                    ) : (
                      <div className="space-y-1.5">
                        {filteredSignals.map((sig, j) => {
                          const tag = TAG_MAP[sig.signal];
                          if (!tag) return null;
                          return (
                            <div key={j} className="flex items-start gap-2">
                              <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold ${tag.cls}`}>
                                {tag.label}
                              </span>
                              <div className="min-w-0 flex-1">
                                <span className="text-xs text-muted-foreground [&_.cite-file]:rounded [&_.cite-file]:bg-blue-500/10 [&_.cite-file]:px-1 [&_.cite-file]:font-mono [&_.cite-file]:text-blue-400 [&_.cite-fn]:rounded [&_.cite-fn]:bg-purple-500/10 [&_.cite-fn]:px-1 [&_.cite-fn]:font-mono [&_.cite-fn]:text-purple-400">
                                  <span dangerouslySetInnerHTML={{ __html: cleanFindingTags(sig.evidence || '') }} />
                                </span>
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
      )}
    </section>
  );
}
