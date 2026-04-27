import { useState, useEffect } from 'react';
import type { ConsensusData, ConsensusReportsData, ConsensusReportFinding, ConsensusReport, ParseDiagnostic } from '@/lib/types';
import { api } from '@/lib/api';
import { timeAgo, renderFindingMarkdown, agentInitials, agentColor } from '@/lib/utils';
import { escapeHtml } from '@/lib/sanitize';
import { EmptyState } from './EmptyState';

interface FindingsMetricsProps {
  consensus: ConsensusData;
  reports?: ConsensusReportsData | null;
  /** If true, shows all consensus runs and hides the "view all" link. */
  showAll?: boolean;
  /** If true, hides the section header. Useful when the parent page provides its own header. */
  hideHeader?: boolean;
  /**
   * Optional pre-filtered run list. When provided (e.g. by FindingsPage with
   * its show/hide retracted toggle), used in place of `consensus.runs` in the
   * fallback runs view. Does not affect the primary `reports` rendering path.
   */
  filteredRuns?: ConsensusData['runs'];
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
  unique_unconfirmed: { label: 'UNIQUE?', filter: 'unique', cls: 'text-unverified bg-unverified/10' },
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

const SEV_FILTER_CHIPS: { key: 'all' | 'critical' | 'high' | 'medium' | 'low'; label: string; cls: string; activeCls: string }[] = [
  { key: 'all', label: 'All', cls: 'text-muted-foreground border-border/40 hover:border-border/60', activeCls: 'text-foreground bg-muted border-border' },
  { key: 'critical', label: 'Critical', cls: 'text-red-400/50 border-red-400/20 hover:border-red-400/40', activeCls: 'text-red-400 bg-red-400/10 border-red-400/40' },
  { key: 'high', label: 'High', cls: 'text-orange-400/50 border-orange-400/20 hover:border-orange-400/40', activeCls: 'text-orange-400 bg-orange-400/10 border-orange-400/40' },
  { key: 'medium', label: 'Medium', cls: 'text-yellow-400/50 border-yellow-400/20 hover:border-yellow-400/40', activeCls: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/40' },
  { key: 'low', label: 'Low', cls: 'text-muted-foreground/50 border-border/40 hover:border-border/60', activeCls: 'text-muted-foreground bg-muted/50 border-border' },
];

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-red-400 bg-red-500/10',
  high: 'text-orange-400 bg-orange-500/10',
  medium: 'text-yellow-400 bg-yellow-500/10',
  low: 'text-muted-foreground bg-muted/50',
};

const CITE_STYLES = '[&_.cite-file]:rounded [&_.cite-file]:bg-blue-500/10 [&_.cite-file]:px-1 [&_.cite-file]:font-mono [&_.cite-file]:text-blue-400 [&_.cite-fn]:rounded [&_.cite-fn]:bg-purple-500/10 [&_.cite-fn]:px-1 [&_.cite-fn]:font-mono [&_.cite-fn]:text-purple-400 [&_.inline-code]:rounded [&_.inline-code]:bg-muted [&_.inline-code]:px-1 [&_.inline-code]:py-0.5 [&_.inline-code]:font-mono [&_.inline-code]:text-[11px] [&_.inline-code]:text-foreground/80 [&_.inline-code-block]:my-1.5 [&_.inline-code-block]:block [&_.inline-code-block]:rounded [&_.inline-code-block]:bg-muted/70 [&_.inline-code-block]:p-2 [&_.inline-code-block]:font-mono [&_.inline-code-block]:text-[11px] [&_.inline-code-block]:text-foreground/70 [&_.inline-code-block]:overflow-x-auto';

interface FindingReviewInfo {
  reviewers: string[];
  assigned: number;
  targetK: number;
}

/**
 * One-line label per diagnostic code — used inside the finding-card banner so
 * the human-facing summary stays short even when the raw `message` field is
 * a full paragraph explaining the root cause.
 */
const DIAGNOSTIC_LABELS: Record<ParseDiagnostic['code'], string> = {
  HTML_ENTITY_ENCODED_TAGS: 'HTML-entity-encoded <agent_finding> tags — parser saw 0 tags',
  HTML_ENTITY_MIXED_PAYLOAD: 'Mixed raw + HTML-entity-encoded tags — some findings dropped',
  SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS: 'Schema drift — Phase-2 consensus verdict types emitted (confirmed/disputed/unique/verdict)',
  SCHEMA_DRIFT_INVENTED_TYPE_TOKENS: 'Schema drift — invented <agent_finding> type names (valid: finding | suggestion | insight)',
  SCHEMA_DRIFT_NESTED_SUBTAGS: 'Schema drift — nested <type>...</type> subtags instead of type="..." attribute',
};

function ReportFinding({ f, reviewInfo, diagnostics }: {
  f: ConsensusReportFinding;
  reviewInfo?: FindingReviewInfo;
  /**
   * ParseDiagnostic entries for this finding's author. The card banner shows
   * only the FIRST occurrence per `(consensusId, agentId, code)` tuple —
   * dedup is applied by the parent before this prop is passed.
   */
  diagnostics?: ParseDiagnostic[];
}) {
  const tagCls = f.tag === 'confirmed' ? 'text-confirmed bg-confirmed/10 border-confirmed/20'
    : f.tag === 'disputed' ? 'text-disputed bg-disputed/10 border-disputed/20'
    : f.tag === 'unverified' ? 'text-unverified bg-unverified/10 border-unverified/20'
    : 'text-unique bg-unique/10 border-unique/20';
  const sevCls = f.severity ? SEVERITY_CLS[f.severity] || '' : '';
  const typeLabel = f.findingType === 'suggestion' ? 'SUGGESTION'
    : f.findingType === 'insight' ? 'INSIGHT'
    : null;
  const typeCls = f.findingType === 'suggestion' ? 'text-blue-400 bg-blue-500/10'
    : f.findingType === 'insight' ? 'text-zinc-400 bg-zinc-500/10'
    : '';

  // Extract first cite as identifier
  const citeMatch = f.finding.match(/<cite\s+tag="file">([^<]+)<\/cite>/);
  const identifier = citeMatch ? citeMatch[1] : null;

  return (
    <div className="rounded-md border border-border/40 hover:border-border/60 transition-colors bg-card/30 px-4 py-3.5">
      {/* Row 1: Tags + Identifier + Agent */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[10px] font-bold ${tagCls}`}>
          {f.tag.toUpperCase()}
        </span>
        {f.severity && (
          <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[10px] font-bold ${sevCls}`}>
            {f.severity.toUpperCase()}
          </span>
        )}
        {typeLabel && (
          <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[10px] font-bold ${typeCls}`}>
            {typeLabel}
          </span>
        )}
        {identifier && (
          <span className="bg-blue-500/10 px-2 py-1 font-mono text-[10px] text-blue-400 border border-blue-500/15 rounded">
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
        {f.unverifiedBy && f.unverifiedBy.length > 0 && (
          <span
            className="cursor-help rounded px-1 py-0.5 font-mono text-[10px] text-unverified/50 transition hover:bg-unverified/10"
            data-tooltip={`Unverified by:\n${f.unverifiedBy.map(u => u.agentId).join(', ')}`}
            data-tooltip-pos="left"
          >
            {f.unverifiedBy.length} ◇
          </span>
        )}
      </div>
      {/* Parse diagnostic banner — rendered only on first occurrence per
          (consensus_id, agentId, code) tuple (dedup handled by parent). Uses
          `escapeHtml` on the `message` field because it may contain
          entity-style samples (e.g. `&lt;agent_finding&gt;`) that MUST stay
          literal text; without escaping they'd be re-decoded and rendered as
          actual tags. */}
      {diagnostics && diagnostics.length > 0 && (
        <div className="mt-1.5 mb-1 space-y-1">
          {diagnostics.map((d, di) => (
            <div
              key={di}
              className="rounded border border-unverified/20 bg-unverified/5 px-2.5 py-1.5"
              data-diagnostic-code={d.code}
            >
              <div className="font-mono text-[10px] font-bold uppercase tracking-wider text-unverified/80">
                ⚠ {d.code}
              </div>
              <div
                className="mt-0.5 text-[11px] text-muted-foreground/80"
                dangerouslySetInnerHTML={{ __html: escapeHtml(DIAGNOSTIC_LABELS[d.code]) + ' — ' + escapeHtml(d.message) }}
              />
            </div>
          ))}
        </div>
      )}
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
      <div className={`finding-md font-inter text-xs leading-relaxed text-muted-foreground ${CITE_STYLES}`}
        dangerouslySetInnerHTML={{ __html: renderFindingMarkdown(f.finding) }} />
      {/* Cross-review coverage badge row */}
      {reviewInfo && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {reviewInfo.reviewers.map(rid => (
            <span
              key={rid}
              title={rid}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full font-mono text-[8px] font-bold text-background opacity-70"
              style={{ backgroundColor: agentColor(rid) }}
            >
              {agentInitials(rid)}
            </span>
          ))}
          <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${
            reviewInfo.assigned >= reviewInfo.targetK
              ? 'text-confirmed/70 bg-confirmed/5'
              : 'text-unverified/70 bg-unverified/5'
          }`}>
            {reviewInfo.assigned >= reviewInfo.targetK ? '\u2713' : '\u26A0'}{' '}
            {reviewInfo.assigned}/{reviewInfo.targetK}
          </span>
        </div>
      )}
    </div>
  );
}

export function FindingsMetrics({ consensus, reports, showAll = false, hideHeader = false, filteredRuns }: FindingsMetricsProps) {
  const sourceRuns = filteredRuns ?? consensus.runs;
  const runs = showAll ? sourceRuns : sourceRuns.slice(0, MAX_RUNS);
  const hasMore = !showAll && sourceRuns.length > MAX_RUNS;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');
  const [sevFilter, setSevFilter] = useState<'all' | 'critical' | 'high' | 'medium' | 'low'>('all');

  const [reportPage, setReportPage] = useState(1);
  const [loadedReports, setLoadedReports] = useState<ConsensusReport[]>([]);
  const [totalReports, setTotalReports] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // consensus_id → most recent retraction reason. Populated from the
  // `roundRetractions` field on the consensus-reports API response. Used to
  // render a banner on retracted rounds and strike through their findings.
  const [retractionsByConsensusId, setRetractionsByConsensusId] =
    useState<Record<string, { reason: string; retracted_at: string }>>({});

  // When the initial reports prop arrives (page 1 data), seed loadedReports.
  // On showAll pages the dedicated pageSize=200 fetch (see next effect) owns
  // loadedReports — skip this seeding path so WebSocket refreshes don't
  // overwrite the full list back to 5 and collapse the paginator.
  useEffect(() => {
    if (!showAll && reports?.reports) {
      setLoadedReports(reports.reports);
      setTotalReports(reports.totalReports ?? reports.reports.length);
      setReportPage(1);
    }
    if (reports?.roundRetractions) {
      const map: Record<string, { reason: string; retracted_at: string }> = {};
      // Later entries overwrite earlier ones → latest-wins for the banner.
      for (const r of reports.roundRetractions) {
        map[r.consensus_id] = { reason: r.reason, retracted_at: r.retracted_at };
      }
      setRetractionsByConsensusId(map);
    }
  }, [reports, showAll]);

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
        if (data.roundRetractions) {
          const map: Record<string, { reason: string; retracted_at: string }> = {};
          for (const r of data.roundRetractions) {
            map[r.consensus_id] = { reason: r.reason, retracted_at: r.retracted_at };
          }
          setRetractionsByConsensusId(map);
        }
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
            Consensus Rounds <span className="text-primary">{consensus.totalRuns ?? consensus.runs.length}</span>
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
            // Build cross-review lookup: findingId → FindingReviewInfo
            const reviewLookup: Record<string, FindingReviewInfo> = {};
            if (report.crossReviewAssignments || report.crossReviewCoverage) {
              // Invert assignments: reviewerAgentId → findingId[] into findingId → reviewerAgentId[]
              const findingReviewers: Record<string, string[]> = {};
              if (report.crossReviewAssignments) {
                for (const [reviewerId, findingIds] of Object.entries(report.crossReviewAssignments)) {
                  for (const fid of findingIds) {
                    (findingReviewers[fid] ??= []).push(reviewerId);
                  }
                }
              }
              // Build from coverage array
              if (report.crossReviewCoverage) {
                for (const cov of report.crossReviewCoverage) {
                  reviewLookup[cov.findingId] = {
                    reviewers: findingReviewers[cov.findingId] || [],
                    assigned: cov.assigned,
                    targetK: cov.targetK,
                  };
                }
              } else {
                // Fallback: only assignments, no coverage — synthesize from reviewer count
                for (const [fid, reviewers] of Object.entries(findingReviewers)) {
                  reviewLookup[fid] = { reviewers, assigned: reviewers.length, targetK: reviewers.length };
                }
              }
            }

            const allFindings = [
              ...report.confirmed,
              ...report.disputed,
              ...report.unverified,
              ...report.unique,
              ...(report.insights || []),
            ];
            const typeFiltered = filter === 'all' ? allFindings
              : filter === 'insight' ? allFindings.filter(f => f.findingType === 'insight' || f.findingType === 'suggestion')
              : allFindings.filter(f => f.tag === filter);
            const filteredFindings = sevFilter === 'all' ? typeFiltered : typeFiltered.filter(f => f.severity === sevFilter);
            const isExpanded = expandedId === report.id;

            // Diagnostic dedup: within this consensus round, show each
            // (agentId, code) pair on exactly ONE finding card — the first
            // one rendered in the filtered list for that agent. Without this,
            // an agent with 5 findings and an HTML_ENTITY_ENCODED_TAGS
            // diagnostic would stamp the banner on all 5, flooding the UI.
            const diagnosticsForFinding = (() => {
              const shown = new Set<string>(); // `${agentId}:${code}`
              return (f: ConsensusReportFinding): ParseDiagnostic[] | undefined => {
                const authorDiags = report.authorDiagnostics?.[f.originalAgentId];
                if (!authorDiags || authorDiags.length === 0) return undefined;
                const fresh = authorDiags.filter(d => {
                  const key = `${f.originalAgentId}:${d.code}`;
                  if (shown.has(key)) return false;
                  shown.add(key);
                  return true;
                });
                return fresh.length > 0 ? fresh : undefined;
              };
            })();

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

            const statChips = [
              { count: confirmedCount, textCls: 'text-confirmed', label: 'confirmed' },
              { count: disputedCount, textCls: 'text-disputed', label: 'disputed' },
              { count: unverifiedCount, textCls: 'text-unverified', label: 'unverified' },
              { count: uniqueCount, textCls: 'text-unique', label: 'unique' },
              { count: insightCount, textCls: 'text-zinc-400', label: 'insights' },
            ].filter(s => s.count > 0);

            // Agents for this report — derive from confirmed/unique/disputed findings
            const allAgentIds = [...new Set(
              allFindings.map(f => f.originalAgentId).filter(Boolean)
            )];
            const agentIds = allAgentIds.slice(0, 5);

            const retraction = retractionsByConsensusId[report.id];
            const isRetracted = !!retraction;
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
                  ${isRetracted ? 'opacity-60 line-through decoration-disputed/40' : ''}
                  ${isExpanded
                    ? 'bg-card border-r-border/60 border-t-border/60 border-b-border/60'
                    : 'bg-card/50 hover:bg-card/70 hover:border-r-border/60 hover:border-t-border/60 hover:border-b-border/60 hover:shadow-sm hover:shadow-black/20 hover:-translate-y-px'
                  }`}
                data-retracted={isRetracted ? 'true' : undefined}
              >
                {/* Retraction banner — inline per-card (not shared AlertBanner
                    refactor per spec non-goals). Rendered above the clickable
                    header so the status is visible in collapsed + expanded
                    views. Strike-through on the card container handles the
                    struck-through findings requirement. */}
                {isRetracted && (
                  <div className="no-underline rounded-t-md border-b border-disputed/30 bg-disputed/10 px-3 py-2 font-mono text-[11px] text-disputed" style={{ textDecoration: 'none' }}>
                    <span className="font-bold">⚠ RETRACTED</span>
                    {retraction!.retracted_at && (
                      <span className="ml-2 text-disputed/70">
                        on {retraction!.retracted_at.slice(0, 10)}
                      </span>
                    )}
                    {retraction!.reason && (
                      <span className="ml-2 text-muted-foreground/80">— {retraction!.reason}</span>
                    )}
                  </div>
                )}
                <button
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
                  aria-expanded={isExpanded}
                  onClick={() => { const opening = !isExpanded; setExpandedId(opening ? report.id : null); if (opening) { setFilter('all'); setSevFilter('all'); } }}
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
                          {allAgentIds.length > 5 && (
                            <span className="font-mono text-[9px] text-muted-foreground/40">
                              +{allAgentIds.length - 5}
                            </span>
                          )}
                        </div>
                      )}
                      <span
                        className="shrink-0 rounded border border-border/30 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground"
                        title={report.id}
                      >
                        {report.id.slice(0, 8)}
                      </span>
                      {report.droppedFindingsByType && Object.keys(report.droppedFindingsByType).length > 0 && (() => {
                        const entries = Object.entries(report.droppedFindingsByType);
                        const total = entries.reduce((n, [, c]) => n + c, 0);
                        const detail = entries.map(([t, c]) => `${t}:${c}`).join(', ');
                        return (
                          <span
                            className="shrink-0 rounded border border-unverified/20 bg-unverified/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-unverified"
                            title={`Silently dropped <agent_finding> tags with invalid type=: ${detail}. These never reach the dashboard, scores, or signals.`}
                          >
                            {total} dropped
                          </span>
                        );
                      })()}
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground/50 shrink-0">
                        {timeAgo(report.timestamp)}
                      </span>
                    </div>
                    {/* Row 2: stat chips with labels. The segmented progress
                        bar that used to live here was dropped because the card
                        already triple-encoded the same status via the
                        border-left accent, the bar, and the chips — keeping
                        only border-left + chips removes ~60% of colored
                        surface without losing any information. */}
                    <div className="mt-1.5 flex items-center gap-3">
                      {statChips.map(chip => (
                        <span key={chip.label} className={`font-mono text-[10px] font-semibold ${chip.textCls}`}>
                          {chip.count} {chip.label}
                        </span>
                      ))}
                    </div>
                    {report.topic && (
                      <div className="mt-1.5 flex items-start gap-2">
                        <span className="shrink-0 rounded border border-border/30 bg-muted/30 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-muted-foreground/50">Topic</span>
                        <span className="font-inter text-[11px] leading-relaxed text-muted-foreground/70">
                          {report.topic}
                        </span>
                      </div>
                    )}
                  </div>
                  {/* Chevron */}
                  <span className={`mt-1 shrink-0 font-mono text-[10px] text-muted-foreground/40 transition-transform duration-150 ${isExpanded ? 'rotate-90 text-primary/60' : 'group-hover:text-muted-foreground/60'}`}>
                    ▸
                  </span>
                </button>

                {isExpanded && (
                  <div className="border-t border-border/20 px-4 pb-4 pt-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground/50">Type:</span>
                      {FILTER_CHIPS.map(tab => (
                        <button key={tab.key} onClick={() => setFilter(tab.key)}
                          className={`rounded-md border px-3 py-1.5 font-mono text-[10px] font-medium transition ${filter === tab.key ? tab.activeCls : tab.cls}`}>
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground/50">Severity:</span>
                      {SEV_FILTER_CHIPS.map(chip => (
                        <button key={chip.key} onClick={() => setSevFilter(chip.key)}
                          className={`rounded-md border px-3 py-1.5 font-mono text-[10px] font-medium transition ${sevFilter === chip.key ? chip.activeCls : chip.cls}`}>
                          {chip.label}
                        </button>
                      ))}
                    </div>
                    {(report.crossReviewAssignments || report.crossReviewCoverage) && (() => {
                      // Invert assignments: reviewerId → findingIds
                      const assignments = report.crossReviewAssignments || {};
                      const reviewerEntries = Object.entries(assignments);
                      // Count under-reviewed findings from coverage data
                      const coverage = report.crossReviewCoverage || [];
                      const totalCovered = coverage.length;
                      const underReviewed = coverage.filter(c => c.assigned < c.targetK);
                      return (
                        <details className="mb-3 rounded-md border border-border/30 bg-card/30">
                          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground select-none">
                            Cross-Review Assignments
                            {report.partialReview && (
                              <span className="rounded border border-unverified/15 bg-unverified/5 px-1.5 py-0.5 font-mono text-[9px] font-bold normal-case tracking-normal text-unverified">
                                partial
                              </span>
                            )}
                            <span className="ml-auto font-mono text-[9px] font-normal normal-case tracking-normal text-muted-foreground/50">
                              {reviewerEntries.length} reviewers · {totalCovered} findings
                            </span>
                          </summary>
                          <div className="border-t border-border/20 px-3 pb-3 pt-2 space-y-2">
                            {reviewerEntries.map(([reviewerId, findingIds]) => (
                              <div key={reviewerId} className="flex items-center gap-2">
                                <span
                                  title={reviewerId}
                                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[8px] font-bold text-background"
                                  style={{ backgroundColor: agentColor(reviewerId) }}
                                >
                                  {agentInitials(reviewerId)}
                                </span>
                                <span className="font-mono text-[10px] text-muted-foreground">{reviewerId}</span>
                                <span className="font-mono text-[10px] text-muted-foreground/40">({findingIds.length})</span>
                                <div className="flex flex-wrap gap-1 ml-1">
                                  {findingIds.map(fid => (
                                    <span key={fid} className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                                      {fid.length > 12 ? fid.slice(0, 12) + '…' : fid}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                            {/* Coverage summary */}
                            {totalCovered > 0 && (
                              <div className="mt-1 pt-1.5 border-t border-border/15">
                                {underReviewed.length > 0 ? (
                                  <span className="rounded border border-unverified/15 bg-unverified/5 px-2 py-1 font-mono text-[10px] font-semibold text-unverified">
                                    ⚠ {underReviewed.length} of {totalCovered} findings under-reviewed
                                  </span>
                                ) : (
                                  <span className="font-mono text-[10px] font-semibold text-confirmed/60">
                                    ✓ All {totalCovered} findings fully covered
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </details>
                      );
                    })()}
                    <div className="space-y-3">
                      {filteredFindings.length === 0 ? (
                        <div className="py-4 text-center text-xs text-muted-foreground">No findings match this filter.</div>
                      ) : (
                        filteredFindings.map((f, j) => <ReportFinding key={j} f={f} reviewInfo={f.id ? reviewLookup[f.id] : undefined} diagnostics={diagnosticsForFinding(f)} />)
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
        <EmptyState
          title="No consensus runs yet"
          hint="Dispatch a consensus round with gossip_dispatch to populate this view."
        />
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

            const isRunRetracted = !!run.retracted;
            return (
              <div
                key={run.taskId + i}
                className={`rounded-md border bg-card transition ${isOpen ? 'border-primary/25' : 'border-border'} ${isRunRetracted ? 'opacity-60' : ''}`}
                data-retracted={isRunRetracted ? 'true' : undefined}
                title={isRunRetracted && run.retractionReason ? `Retracted: ${run.retractionReason}` : undefined}
              >
                {isRunRetracted && (
                  <div className="rounded-t-md border-b border-disputed/30 bg-disputed/10 px-3 py-1.5 font-mono text-[10px] text-disputed" style={{ textDecoration: 'none' }}>
                    <span className="font-bold uppercase tracking-wider">⚠ Retracted</span>
                    {run.retractedAt && (
                      <span className="ml-2 text-disputed/70">
                        on {run.retractedAt.slice(0, 10)}
                      </span>
                    )}
                    {run.retractionReason && (
                      <span className="ml-2 text-muted-foreground/80">— {run.retractionReason}</span>
                    )}
                  </div>
                )}
                {/* Header — clickable */}
                <button
                  aria-expanded={isOpen}
                  onClick={() => { const opening = !isOpen; setExpandedId(opening ? run.taskId : null); if (opening) { setFilter('all'); setSevFilter('all'); } }}
                  className="flex w-full items-center p-3 text-left transition hover:bg-accent/50"
                >
                  <span className={`mr-3 font-mono text-xs text-muted-foreground transition ${isOpen ? 'text-primary' : ''}`}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[10px] text-primary/50">{run.taskId}</span>
                        <span className={`font-mono text-sm font-semibold text-foreground ${isRunRetracted ? 'line-through decoration-disputed/40' : ''}`}>{runTotal} findings</span>
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
                        <span key={s.key} className={`font-mono text-[10px] font-semibold ${s.text} ${isRunRetracted ? 'line-through decoration-disputed/40' : ''}`}>
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
                                  <span className="finding-md" dangerouslySetInnerHTML={{ __html: renderFindingMarkdown(sig.evidence || '') }} />
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
