import { useState, useEffect } from 'react';
import type { ConsensusData, ConsensusReportsData, ConsensusReportFinding, ConsensusReport } from '@/lib/types';
import { api } from '@/lib/api';
import { timeAgo, cleanFindingTags, agentInitials, agentColor } from '@/lib/utils';

interface FindingsMetricsProps {
  consensus: ConsensusData;
  reports?: ConsensusReportsData | null;
  /** If true, shows all consensus runs and hides the "view all" link. */
  showAll?: boolean;
  /** If true, hides the section header. Useful when the parent page provides its own header. */
  hideHeader?: boolean;
}

const MAX_RUNS = 5;

type FilterType = 'all' | 'confirmed' | 'disputed' | 'unverified' | 'unique' | 'insight';

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
  { key: 'all', label: 'All', cls: 'text-muted-foreground border-border/40 hover:border-border/60', activeCls: 'text-foreground bg-muted border-border' },
  { key: 'confirmed', label: 'Confirmed', cls: 'text-confirmed/50 border-confirmed/20 hover:border-confirmed/40', activeCls: 'text-confirmed bg-confirmed/10 border-confirmed/40' },
  { key: 'unique', label: 'Unique', cls: 'text-unique/50 border-unique/20 hover:border-unique/40', activeCls: 'text-unique bg-unique/10 border-unique/40' },
  { key: 'disputed', label: 'Disputed', cls: 'text-disputed/50 border-disputed/20 hover:border-disputed/40', activeCls: 'text-disputed bg-disputed/10 border-disputed/40' },
  { key: 'unverified', label: 'Unverified', cls: 'text-unverified/50 border-unverified/20 hover:border-unverified/40', activeCls: 'text-unverified bg-unverified/10 border-unverified/40' },
  { key: 'insight', label: 'Insight', cls: 'text-zinc-500 border-zinc-500/20 hover:border-zinc-500/40', activeCls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/40' },
];

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-red-400 bg-red-500/10',
  high: 'text-orange-400 bg-orange-500/10',
  medium: 'text-yellow-400 bg-yellow-500/10',
  low: 'text-muted-foreground bg-muted/50',
};

const CITE_STYLES = '[&_.cite-file]:rounded [&_.cite-file]:bg-blue-500/10 [&_.cite-file]:px-1 [&_.cite-file]:font-mono [&_.cite-file]:text-blue-400 [&_.cite-fn]:rounded [&_.cite-fn]:bg-purple-500/10 [&_.cite-fn]:px-1 [&_.cite-fn]:font-mono [&_.cite-fn]:text-purple-400 [&_.inline-code]:rounded [&_.inline-code]:bg-muted [&_.inline-code]:px-1 [&_.inline-code]:py-0.5 [&_.inline-code]:font-mono [&_.inline-code]:text-[11px] [&_.inline-code]:text-foreground/80 [&_.inline-code-block]:my-1.5 [&_.inline-code-block]:block [&_.inline-code-block]:rounded [&_.inline-code-block]:bg-muted/70 [&_.inline-code-block]:p-2 [&_.inline-code-block]:font-mono [&_.inline-code-block]:text-[11px] [&_.inline-code-block]:text-foreground/70 [&_.inline-code-block]:overflow-x-auto';

function ReportFinding({ f }: { f: ConsensusReportFinding }) {
  const tagCls = f.tag === 'confirmed' ? 'text-confirmed bg-confirmed/10 border-confirmed/20'
    : f.tag === 'disputed' ? 'text-disputed bg-disputed/10 border-disputed/20'
    : f.tag === 'unverified' ? 'text-unverified bg-unverified/10 border-unverified/20'
    : 'text-unique bg-unique/10 border-unique/20';
  const sevCls = f.severity ? SEVERITY_CLS[f.severity] || '' : '';
  const typeLabel = f.findingType === 'suggestion' ? '💡 SUGGESTION'
    : f.findingType === 'insight' ? 'INSIGHT'
    : null;
  const typeCls = f.findingType === 'suggestion' ? 'text-blue-400 bg-blue-500/10'
    : f.findingType === 'insight' ? 'text-zinc-400 bg-zinc-500/10'
    : '';

  // Extract first cite as identifier
  const citeMatch = f.finding.match(/<cite\s+tag="file">([^<]+)<\/cite>/);
  const identifier = citeMatch ? citeMatch[1] : null;

  return (
    <div className="rounded-md border border-border/30 bg-card/30 px-3 py-2.5">
      {/* Row 1: Tags + Identifier + Agent */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold ${tagCls}`}>
          {f.tag.toUpperCase()}
        </span>
        {f.severity && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${sevCls}`}>
            {f.severity.toUpperCase()}
          </span>
        )}
        {typeLabel && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${typeCls}`}>
            {typeLabel}
          </span>
        )}
        {identifier && (
          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-[9px] text-blue-400">
            {identifier}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/40">{f.originalAgentId}</span>
        {f.confirmedBy && f.confirmedBy.length > 0 && (() => {
          const unique = [...new Set(f.confirmedBy)];
          return (
            <span
              className="cursor-help rounded px-1 py-0.5 font-mono text-[10px] text-confirmed/50 transition hover:bg-confirmed/10"
              data-tooltip={`Verified by:\n${unique.join(', ')}`}
              data-tooltip-pos="left"
            >
              +{unique.length} ✓
            </span>
          );
        })()}
        {f.disputedBy && f.disputedBy.length > 0 && (
          <span
            className="cursor-help rounded px-1 py-0.5 font-mono text-[10px] text-disputed/50 transition hover:bg-disputed/10"
            data-tooltip={`Disputed by:\n${f.disputedBy.map(d => d.agentId).join(', ')}`}
            data-tooltip-pos="left"
          >
            {f.disputedBy.length} ⚡
          </span>
        )}
      </div>
      {/* Row 2: Disputed by details (if disputed) */}
      {f.disputedBy && f.disputedBy.length > 0 && (
        <div className="mt-1.5 mb-1 rounded border border-disputed/10 bg-disputed/5 px-2.5 py-1.5">
          {f.disputedBy.map((d, di) => (
            <div key={di} className="text-[11px]">
              <span className="font-mono font-bold text-disputed/70">{d.agentId}</span>
              <span className="text-muted-foreground/60"> — {d.reason || d.evidence || 'No reason given'}</span>
            </div>
          ))}
        </div>
      )}
      {/* Finding text */}
      <div className={`text-xs leading-relaxed text-muted-foreground ${CITE_STYLES}`}
        dangerouslySetInnerHTML={{ __html: cleanFindingTags(f.finding) }} />
    </div>
  );
}

export function FindingsMetrics({ consensus, reports, showAll = false, hideHeader = false }: FindingsMetricsProps) {
  const runs = showAll ? consensus.runs : consensus.runs.slice(0, MAX_RUNS);
  const hasMore = !showAll && consensus.runs.length > MAX_RUNS;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');

  const [reportPage, setReportPage] = useState(1);
  const [loadedReports, setLoadedReports] = useState<ConsensusReport[]>([]);
  const [totalReports, setTotalReports] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // When the initial reports prop arrives (page 1 data), seed loadedReports
  useEffect(() => {
    if (reports?.reports) {
      setLoadedReports(reports.reports);
      setTotalReports(reports.totalReports ?? reports.reports.length);
      setReportPage(1);
    }
  }, [reports]);

  // On showAll pages, fetch all reports (not just the initial 5-page preview)
  useEffect(() => {
    if (!showAll) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api<ConsensusReportsData>('consensus-reports?page=1&pageSize=200');
        if (cancelled) return;
        setLoadedReports(data.reports || []);
        setTotalReports(data.totalReports ?? (data.reports?.length || 0));
        setReportPage(1);
      } catch {
        // keep the seeded page-1 data
      }
    })();
    return () => { cancelled = true; };
  }, [showAll]);

  const handleLoadMore = async () => {
    const nextPage = reportPage + 1;
    setLoadingMore(true);
    try {
      const data = await api<ConsensusReportsData>(`consensus-reports?page=${nextPage}&pageSize=5`);
      setLoadedReports(prev => [...prev, ...(data.reports || [])]);
      setTotalReports(data.totalReports ?? totalReports);
      setReportPage(nextPage);
    } finally {
      setLoadingMore(false);
    }
  };

  // Show at most MAX_RUNS structured reports (or all when showAll is true)
  const sortedReports = loadedReports
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Pagination for showAll view — 10 per page
  const PAGE_SIZE = 10;
  const [debatePage, setDebatePage] = useState(0);
  const totalDebatePages = Math.max(1, Math.ceil(sortedReports.length / PAGE_SIZE));
  const clampedDebatePage = Math.min(debatePage, totalDebatePages - 1);
  const latestReports = showAll
    ? sortedReports.slice(clampedDebatePage * PAGE_SIZE, (clampedDebatePage + 1) * PAGE_SIZE)
    : sortedReports.slice(0, MAX_RUNS);

  // Group by date bucket (today / yesterday / N days ago)
  const dateBucket = (iso: string): string => {
    const now = new Date();
    const d = new Date(iso);
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diffDays <= 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    return d.toISOString().slice(0, 10);
  };

  return (
    <section>
      {!hideHeader && (
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
            Consensus Rounds <span className="text-primary">{consensus.runs.length}</span>
          </h2>
          {!showAll && (
            <a href="/dashboard/debates" className="font-mono text-xs text-muted-foreground transition hover:text-primary">
              view all
            </a>
          )}
        </div>
      )}

      {latestReports.length > 0 ? (
        <div className="space-y-2">
          {latestReports.map((report, _i) => {
            // Render bucket separator above the first report of each new date group
            const prev = _i > 0 ? latestReports[_i - 1] : null;
            const currentBucket = showAll ? dateBucket(report.timestamp) : null;
            const prevBucket = showAll && prev ? dateBucket(prev.timestamp) : null;
            const showBucketHeader = showAll && currentBucket !== prevBucket;
            const allFindings = [
              ...report.confirmed,
              ...report.disputed,
              ...report.unverified,
              ...report.unique,
              ...(report.insights || []),
            ];
            const filteredFindings = filter === 'all' ? allFindings
              : filter === 'insight' ? allFindings.filter(f => f.findingType === 'insight' || f.findingType === 'suggestion')
              : allFindings.filter(f => f.tag === filter);
            const isExpanded = expandedId === report.id;

            const total = allFindings.length || 1;
            const confirmedCount = report.confirmed.length;
            const disputedCount = report.disputed.length;
            const unverifiedCount = report.unverified.length;
            const uniqueCount = report.unique.length;
            const insightCount = (report.insights || []).length;

            // Determine dominant quality: confirmed > disputed > mixed/unverified
            const dominantBorderCls = (() => {
              if (total <= 1) return 'border-l-border/40';
              const confirmedRatio = confirmedCount / total;
              const disputedRatio = disputedCount / total;
              if (confirmedRatio >= 0.5) return 'border-l-confirmed/60';
              if (disputedRatio >= 0.4) return 'border-l-disputed/60';
              return 'border-l-unverified/50';
            })();

            const segments = [
              { count: confirmedCount, cls: 'bg-confirmed' },
              { count: disputedCount, cls: 'bg-disputed' },
              { count: unverifiedCount, cls: 'bg-unverified' },
              { count: uniqueCount, cls: 'bg-unique' },
              { count: insightCount, cls: 'bg-zinc-500' },
            ].filter(s => s.count > 0);

            const statChips = [
              { count: confirmedCount, textCls: 'text-confirmed', label: 'confirmed' },
              { count: disputedCount, textCls: 'text-disputed', label: 'disputed' },
              { count: unverifiedCount, textCls: 'text-unverified', label: 'unverified' },
              { count: uniqueCount, textCls: 'text-unique', label: 'unique' },
              { count: insightCount, textCls: 'text-zinc-400', label: 'insights' },
            ].filter(s => s.count > 0);

            // Agents for this report — derive from confirmed/unique/disputed findings
            const agentIds = [...new Set(
              allFindings.map(f => f.originalAgentId).filter(Boolean)
            )].slice(0, 5);

            return (
              <div key={report.id}>
                {showBucketHeader && (
                  <div className={`mb-2 flex items-center gap-3 ${_i > 0 ? 'mt-4' : ''}`}>
                    <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      {currentBucket}
                    </span>
                    <div className="h-px flex-1 bg-border/30" />
                  </div>
                )}
              <div
                className={`group rounded-md border-l-2 border border-border/40 transition-all duration-150
                  ${dominantBorderCls}
                  ${isExpanded
                    ? 'bg-card border-r-border/60 border-t-border/60 border-b-border/60'
                    : 'bg-card/50 hover:bg-card/70 hover:border-r-border/60 hover:border-t-border/60 hover:border-b-border/60 hover:shadow-sm hover:shadow-black/20 hover:-translate-y-px'
                  }`}
              >
                <button
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
                  onClick={() => setExpandedId(isExpanded ? null : report.id)}
                >
                  <div className="flex-1 min-w-0">
                    {/* Row 1: count + agents + time */}
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold text-foreground">{allFindings.length}</span>
                      <span className="text-[11px] text-muted-foreground/70">findings</span>
                      <span className="text-muted-foreground/30 text-[10px]">·</span>
                      <span className="text-[11px] text-muted-foreground/60">{report.rounds}r</span>
                      {/* Agent initials as colored dots */}
                      {agentIds.length > 0 && (
                        <div className="flex items-center gap-1 ml-1">
                          {agentIds.map(id => (
                            <span
                              key={id}
                              title={id}
                              className="inline-flex h-4 w-4 items-center justify-center rounded-full font-mono text-[8px] font-bold text-background"
                              style={{ backgroundColor: agentColor(id) }}
                            >
                              {agentInitials(id)}
                            </span>
                          ))}
                          {allFindings.length > 0 && [...new Set(allFindings.map(f => f.originalAgentId).filter(Boolean))].length > 5 && (
                            <span className="font-mono text-[9px] text-muted-foreground/40">
                              +{[...new Set(allFindings.map(f => f.originalAgentId).filter(Boolean))].length - 5}
                            </span>
                          )}
                        </div>
                      )}
                      <span
                        className="shrink-0 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary/90"
                        title={report.id}
                      >
                        {report.id.slice(0, 8)}
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground/50 shrink-0">
                        {timeAgo(report.timestamp)}
                      </span>
                    </div>
                    {/* Row 2: segmented progress bar */}
                    <div className="mt-1.5 flex h-1 w-full overflow-hidden rounded-full bg-muted/20">
                      {segments.map((s, si) => (
                        <div key={si} className={`${s.cls} opacity-80`} style={{ width: `${(s.count / total) * 100}%` }} />
                      ))}
                    </div>
                    {/* Row 3: stat chips with labels */}
                    <div className="mt-1 flex items-center gap-3">
                      {statChips.map(chip => (
                        <span key={chip.label} className={`font-mono text-[10px] font-semibold ${chip.textCls}`}>
                          {chip.count} {chip.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* Chevron */}
                  <span className={`mt-1 shrink-0 font-mono text-[10px] text-muted-foreground/40 transition-transform duration-150 ${isExpanded ? 'rotate-90 text-primary/60' : 'group-hover:text-muted-foreground/60'}`}>
                    ▸
                  </span>
                </button>

                {isExpanded && (
                  <div className="border-t border-border/20 px-4 pb-4 pt-3">
                    <div className="mb-2 flex gap-2">
                      {FILTER_CHIPS.map(tab => (
                        <button key={tab.key} onClick={() => setFilter(tab.key)}
                          className={`rounded-full border px-2.5 py-1 font-mono text-[10px] font-medium transition ${filter === tab.key ? tab.activeCls : tab.cls}`}>
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <div className="space-y-2">
                      {filteredFindings.length === 0 ? (
                        <div className="py-4 text-center text-xs text-muted-foreground">No findings match this filter.</div>
                      ) : (
                        filteredFindings.map((f, j) => <ReportFinding key={j} f={f} />)
                      )}
                    </div>
                  </div>
                )}
              </div>
              </div>
            );
          })}
          {showAll && totalDebatePages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-4 font-mono text-[11px] text-muted-foreground">
              <button
                onClick={() => setDebatePage(p => Math.max(0, p - 1))}
                disabled={clampedDebatePage === 0}
                className="rounded-sm border border-border/40 bg-card px-3 py-1 transition hover:bg-accent/50 disabled:opacity-30"
              >◂ Prev</button>
              <span>Page {clampedDebatePage + 1} of {totalDebatePages}</span>
              <button
                onClick={() => setDebatePage(p => Math.min(totalDebatePages - 1, p + 1))}
                disabled={clampedDebatePage >= totalDebatePages - 1}
                className="rounded-sm border border-border/40 bg-card px-3 py-1 transition hover:bg-accent/50 disabled:opacity-30"
              >Next ▸</button>
            </div>
          )}
        </div>
      ) : runs.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No consensus runs yet.</div>
      ) : (
        <div className="space-y-2">
          {runs.map((run, i) => {
            const c = run.counts;
            const runTotal = (c.agreement || 0) + (c.disagreement || 0) + (c.hallucination || 0) + (c.unverified || 0) + (c.unique || 0) + (c.new || 0);
            const barTotal = runTotal || 1;
            const isOpen = expandedId === run.taskId;

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
                  onClick={() => setExpandedId(isOpen ? null : run.taskId)}
                  className="flex w-full items-center p-3 text-left transition hover:bg-accent/50"
                >
                  <span className={`mr-3 font-mono text-xs text-muted-foreground transition ${isOpen ? 'text-primary' : ''}`}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[10px] text-primary/50">{run.taskId}</span>
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
                      <div className="space-y-2">
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
