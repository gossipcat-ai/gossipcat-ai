import { useState, useEffect, useMemo } from 'react';
import type React from 'react';
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

const FILTER_CHIPS: { key: FilterType; label: string; cls: string; activeCls: string; activeStyle?: React.CSSProperties; inactiveStyle?: React.CSSProperties; tooltip?: string }[] = [
  { key: 'all', label: 'All', cls: 'border-border/40 hover:border-border/60', activeCls: 'border-border', activeStyle: { color: 'var(--text)', background: 'var(--surface-sunk)' }, inactiveStyle: { color: 'var(--text-dim)' } },
  { key: 'confirmed', label: 'Confirmed', cls: 'text-confirmed/50 border-confirmed/20 hover:border-confirmed/40', activeCls: 'text-confirmed bg-confirmed/10 border-confirmed/40' },
  { key: 'unique', label: 'Unique', cls: 'text-unique/50 border-unique/20 hover:border-unique/40', activeCls: 'text-unique bg-unique/10 border-unique/40' },
  { key: 'disputed', label: 'Disputed', cls: 'text-disputed/50 border-disputed/20 hover:border-disputed/40', activeCls: 'text-disputed bg-disputed/10 border-disputed/40' },
  { key: 'unverified', label: 'Unverified', cls: 'text-unverified/50 border-unverified/20 hover:border-unverified/40', activeCls: 'text-unverified bg-unverified/10 border-unverified/40' },
  { key: 'insight', label: 'Insight', cls: 'text-insight/60 border-insight/20 hover:border-insight/40', activeCls: 'text-insight bg-insight/10 border-insight/40', tooltip: 'Observations without a specific file:line anchor. Not scored — cannot be confirmed or disputed by peers.' },
];

const SEV_FILTER_CHIPS: { key: 'all' | 'critical' | 'high' | 'medium' | 'low'; label: string; cls: string; activeCls: string; activeStyle?: React.CSSProperties; inactiveStyle?: React.CSSProperties }[] = [
  { key: 'all', label: 'All', cls: 'border-border/40 hover:border-border/60', activeCls: 'border-border', activeStyle: { color: 'var(--text)', background: 'var(--surface-sunk)' }, inactiveStyle: { color: 'var(--text-dim)' } },
  { key: 'critical', label: 'Critical', cls: 'text-bad/50 border-bad/20 hover:border-bad/40', activeCls: 'text-bad bg-bad/10 border-bad/40' },
  { key: 'high', label: 'High', cls: 'text-severity-high/50 border-severity-high/20 hover:border-severity-high/40', activeCls: 'text-severity-high bg-severity-high/10 border-severity-high/40' },
  { key: 'medium', label: 'Medium', cls: 'text-severity-medium/50 border-severity-medium/20 hover:border-severity-medium/40', activeCls: 'text-severity-medium bg-severity-medium/10 border-severity-medium/40' },
  { key: 'low', label: 'Low', cls: 'border-border/40 hover:border-border/60', activeCls: 'border-border', activeStyle: { color: 'var(--text-dim)', background: 'color-mix(in oklch, var(--surface-sunk) 50%, transparent)' }, inactiveStyle: { color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' } },
];

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-bad bg-bad/10',
  high: 'text-severity-high bg-severity-high/10',
  medium: 'text-severity-medium bg-severity-medium/10',
  low: '',
};
const SEVERITY_STYLE_LOW: React.CSSProperties = { color: 'var(--text-dim)', background: 'color-mix(in oklch, var(--surface-sunk) 50%, transparent)' };

// Note: [&_.inline-code]:bg-surface-sunk and text-text are CSS custom property
// references inside Tailwind arbitrary selectors — these target child elements
// rendered by renderFindingMarkdown so they can't use inline style on the parent.
// Using Tailwind's [&_...] arbitrary variant with CSS custom-property values.
const CITE_STYLES = '[&_.cite-file]:rounded [&_.cite-file]:bg-[color-mix(in_oklch,var(--cite-file)_10%,transparent)] [&_.cite-file]:px-1 [&_.cite-file]:font-mono [&_.cite-file]:text-[var(--cite-file)] [&_.cite-fn]:rounded [&_.cite-fn]:bg-[color-mix(in_oklch,var(--cite-fn)_10%,transparent)] [&_.cite-fn]:px-1 [&_.cite-fn]:font-mono [&_.cite-fn]:text-[var(--cite-fn)] [&_.inline-code]:rounded [&_.inline-code]:[background:var(--surface-sunk)] [&_.inline-code]:px-1 [&_.inline-code]:py-0.5 [&_.inline-code]:font-mono [&_.inline-code]:text-[11px] [&_.inline-code]:[color:color-mix(in_oklch,var(--text)_80%,transparent)] [&_.inline-code-block]:my-1.5 [&_.inline-code-block]:block [&_.inline-code-block]:rounded [&_.inline-code-block]:[background:color-mix(in_oklch,var(--surface-sunk)_70%,transparent)] [&_.inline-code-block]:p-2 [&_.inline-code-block]:font-mono [&_.inline-code-block]:text-[11px] [&_.inline-code-block]:[color:color-mix(in_oklch,var(--text)_70%,transparent)] [&_.inline-code-block]:overflow-x-auto';

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
  const sevStyle: React.CSSProperties | undefined = f.severity === 'low' ? SEVERITY_STYLE_LOW : undefined;
  const typeLabel = f.findingType === 'suggestion' ? 'SUGGESTION'
    : f.findingType === 'insight' ? 'INSIGHT'
    : null;
  // suggestion = informational action → --info teal; insight = neutral
  // observation → text-dim grey. Maps the typeCls tokens to DESIGN.md.
  const typeCls = f.findingType === 'suggestion' ? 'text-info bg-info/10'
    : f.findingType === 'insight' ? 'text-text-dim bg-text-dim/10'
    : '';

  // Extract first cite as identifier
  const citeMatch = f.finding.match(/<cite\s+tag="file">([^<]+)<\/cite>/);
  const identifier = citeMatch ? citeMatch[1] : null;

  return (
    <div className="rounded-md border border-border/40 hover:border-border/60 transition-colors px-4 py-3.5" style={{ background: 'color-mix(in oklch, var(--surface-elev) 30%, transparent)' }}>
      {/* Row 1: Tags + Identifier + Agent */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[10px] font-bold ${tagCls}`}>
          {f.tag.toUpperCase()}
        </span>
        {f.severity && (
          <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[10px] font-bold ${sevCls}`} style={sevStyle}>
            {f.severity.toUpperCase()}
          </span>
        )}
        {typeLabel && (
          <span className={`shrink-0 rounded border px-2 py-1 font-mono text-[10px] font-bold ${typeCls}`}>
            {typeLabel}
          </span>
        )}
        {identifier && (
          <span className="bg-info/10 px-2 py-1 font-mono text-[10px] text-info border border-info/15 rounded">
            {identifier}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 40%, transparent)' }}>{f.originalAgentId}</span>
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
                className="mt-0.5 text-[11px]"
                style={{ color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }}
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
              <span style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}> — {d.reason || d.evidence || 'No reason given'}</span>
            </div>
          ))}
        </div>
      )}
      {/* Finding text */}
      <div className={`finding-md font-inter text-xs leading-relaxed ${CITE_STYLES}`} style={{ color: 'var(--text-dim)' }}
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
  // Per-report filter state: reportId → active filter value. Default 'all' for any absent key.
  const [filterByReport, setFilterByReport] = useState<Record<string, FilterType>>({});
  const [sevByReport, setSevByReport] = useState<Record<string, 'all' | 'critical' | 'high' | 'medium' | 'low'>>({});

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

  // Reset debatePage when the report set shrinks such that the current page is out of range.
  useEffect(() => {
    if (debatePage >= totalDebatePages) {
      setDebatePage(0);
    }
  }, [debatePage, totalDebatePages]);
  const latestReports = showAll
    ? sortedReports.slice(clampedDebatePage * PAGE_SIZE, (clampedDebatePage + 1) * PAGE_SIZE)
    : sortedReports.slice(0, MAX_RUNS);

  // Memoized cross-review lookup: reportId → (findingId → FindingReviewInfo).
  // Rebuilt only when loadedReports changes, not on every render.
  const reviewLookupByReport = useMemo(() => {
    const byReport = new Map<string, Record<string, FindingReviewInfo>>();
    for (const report of loadedReports) {
      const reviewLookup: Record<string, FindingReviewInfo> = {};
      if (report.crossReviewAssignments || report.crossReviewCoverage) {
        const findingReviewers: Record<string, string[]> = {};
        if (report.crossReviewAssignments) {
          for (const [reviewerId, findingIds] of Object.entries(report.crossReviewAssignments)) {
            for (const fid of findingIds) {
              (findingReviewers[fid] ??= []).push(reviewerId);
            }
          }
        }
        if (report.crossReviewCoverage) {
          for (const cov of report.crossReviewCoverage) {
            reviewLookup[cov.findingId] = {
              reviewers: findingReviewers[cov.findingId] || [],
              assigned: cov.assigned,
              targetK: cov.targetK,
            };
          }
        } else {
          for (const [fid, reviewers] of Object.entries(findingReviewers)) {
            reviewLookup[fid] = { reviewers, assigned: reviewers.length, targetK: reviewers.length };
          }
        }
      }
      byReport.set(report.id, reviewLookup);
    }
    return byReport;
  }, [loadedReports]);

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
          <h2 className="h-section">
            Consensus Rounds <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{consensus.totalRuns ?? consensus.runs.length}</span>
          </h2>
          {!showAll && (
            <a href="/dashboard/debates" className="font-mono text-xs transition" style={{ color: 'var(--text-dim)' }}>
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
            // Resolve per-report filter values (default 'all' if not yet set)
            const filter = filterByReport[report.id] ?? 'all';
            const sevFilter = sevByReport[report.id] ?? 'all';

            // Retrieve memoized cross-review lookup for this report
            const reviewLookup = reviewLookupByReport.get(report.id) ?? {};

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

            // Determine dominant quality: confirmed > disputed > mixed/unverified.
            // Single-finding rounds get the same ratio logic as multi-finding rounds
            // so a 1/1 confirmed round paints green, not neutral grey.
            const dominantBorderCls = (() => {
              if (total === 0) return 'border-l-border/40';
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
                    <span className="h-section">
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
                    ? 'border-r-border/60 border-t-border/60 border-b-border/60'
                    : 'hover:border-r-border/60 hover:border-t-border/60 hover:border-b-border/60 hover:-translate-y-px'
                  }`}
                style={{ background: isExpanded ? 'var(--surface-elev)' : 'color-mix(in oklch, var(--surface-elev) 50%, transparent)' }}
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
                      <span className="ml-2" style={{ color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }}>— {retraction!.reason}</span>
                    )}
                  </div>
                )}
                <button
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
                  aria-expanded={isExpanded}
                  onClick={() => { const opening = !isExpanded; setExpandedId(opening ? report.id : null); if (opening) { setFilterByReport(prev => ({ ...prev, [report.id]: 'all' })); setSevByReport(prev => ({ ...prev, [report.id]: 'all' })); } }}
                >
                  <div className="flex-1 min-w-0">
                    {/* Row 1: count + agents + time */}
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold" style={{ color: 'var(--text)' }}>{allFindings.length}</span>
                      <span className="text-[11px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>findings</span>
                      <span className="text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 30%, transparent)' }}>·</span>
                      <span className="text-[11px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>{report.rounds}r</span>
                      {/* Agent initials as colored dots */}
                      {agentIds.length > 0 && (
                        <div className="flex items-center gap-1 ml-1">
                          {agentIds.map(id => (
                            <span
                              key={id}
                              title={id}
                              className="inline-flex h-4 w-4 items-center justify-center rounded-full font-mono text-[8px] font-bold"
                              style={{ color: 'var(--surface)', backgroundColor: agentColor(id) }}
                            >
                              {agentInitials(id)}
                            </span>
                          ))}
                          {allAgentIds.length > 5 && (
                            <span className="font-mono text-[9px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 40%, transparent)' }}>
                              +{allAgentIds.length - 5}
                            </span>
                          )}
                        </div>
                      )}
                      <span
                        className="shrink-0 rounded border border-border/30 px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                        style={{ background: 'color-mix(in oklch, var(--surface-sunk) 40%, transparent)', color: 'var(--text-dim)' }}
                        title={report.id}
                      >
                        {report.id.slice(0, 8)}
                      </span>
                      {report.zeroTagAgents && report.zeroTagAgents.length > 0 && (() => {
                        const shown = report.zeroTagAgents;
                        const overflow = report.zeroTagOverflow ?? 0;
                        const total = shown.length + overflow;
                        const detail = overflow > 0
                          ? `${shown.join(', ')} (+${overflow} more)`
                          : shown.join(', ');
                        return (
                          <span
                            className="shrink-0 rounded border border-unverified/20 bg-unverified/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-unverified"
                            title={`Zero-tag agents — emitted no parseable <agent_finding> tags (likely paraphrased relay or HTML-entity encoding). See HANDBOOK invariant #12. Agents: ${detail}`}
                          >
                            {total} zero-tag
                          </span>
                        );
                      })()}
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
                      {/* Fail-loud round warnings (spec 2026-06-11-round-context-
                          fail-loud §4/§6). Aggregated visually by code with a
                          per-code count (e.g. "anchor_master_fallback ×4") while
                          the underlying array keeps every instance; the tooltip
                          lists per-instance messages. Semantic --warn amber per
                          DESIGN.md — NOT terracotta --accent. */}
                      {report.warnings && report.warnings.length > 0 && (() => {
                        const byCode = new Map<string, string[]>();
                        for (const w of report.warnings) {
                          const list = byCode.get(w.code) ?? [];
                          list.push(w.agentId ? `${w.agentId}: ${w.message}` : w.message);
                          byCode.set(w.code, list);
                        }
                        return Array.from(byCode.entries()).map(([code, msgs]) => (
                          <span
                            key={code}
                            className="shrink-0 rounded border border-warn/30 bg-warn/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-warn"
                            title={msgs.join('\n')}
                          >
                            {code}{msgs.length > 1 ? ` ×${msgs.length}` : ''}
                          </span>
                        ));
                      })()}
                      <span className="ml-auto font-mono text-[10px] shrink-0" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
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
                        <span className="shrink-0 rounded border border-border/30 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 30%, transparent)', color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>Topic</span>
                        <span className="font-inter text-[11px] leading-relaxed" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>
                          {report.topic}
                        </span>
                      </div>
                    )}
                  </div>
                  {/* Chevron */}
                  <span
                    className={`mt-1 shrink-0 font-mono text-[10px] transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                    style={{ color: isExpanded ? 'color-mix(in oklch, var(--ink) 60%, transparent)' : 'color-mix(in oklch, var(--text-dim) 40%, transparent)' }}
                  >
                    ▸
                  </span>
                </button>

                {isExpanded && (
                  <div className="border-t border-border/20 px-4 pb-4 pt-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>Type:</span>
                      {FILTER_CHIPS.map(tab => (
                        <button key={tab.key} onClick={() => setFilterByReport(prev => ({ ...prev, [report.id]: tab.key }))}
                          className={`rounded-md border px-3 py-1.5 font-mono text-[10px] font-medium transition ${filter === tab.key ? tab.activeCls : tab.cls}`}
                          style={filter === tab.key ? tab.activeStyle : tab.inactiveStyle}
                          {...(tab.tooltip ? { 'data-tooltip': tab.tooltip } : {})}>
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    <div className="mb-2 flex items-center gap-2">
                      <span className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>Severity:</span>
                      {SEV_FILTER_CHIPS.map(chip => (
                        <button key={chip.key} onClick={() => setSevByReport(prev => ({ ...prev, [report.id]: chip.key }))}
                          className={`rounded-md border px-3 py-1.5 font-mono text-[10px] font-medium transition ${sevFilter === chip.key ? chip.activeCls : chip.cls}`}
                          style={sevFilter === chip.key ? chip.activeStyle : chip.inactiveStyle}>
                          {chip.label}
                        </button>
                      ))}
                    </div>
                    {/* Degraded-mode detail now driven by report.warnings (spec
                        §4 — the warnings channel subsumes the legacy
                        coverageDegraded / relayCrossReviewSkipped fields, deleted
                        in PR-C). Old persisted reports are mapped to synthetic
                        warnings at READ time (routes.ts
                        normalizeLegacyDegradedFields), so this single path renders
                        both. Amber --warn per DESIGN.md. */}
                    {(report.warnings ?? []).filter(w => w.code === 'coverage_degraded').map((w, i) => (
                      <div key={`cd-${i}`} className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2">
                        <p className="font-mono text-[10px] font-semibold text-warn">⚠ {w.message}</p>
                      </div>
                    ))}
                    {report.zeroTagAgents && report.zeroTagAgents.length > 0 && (
                      <div className="mb-3 rounded-md border border-unverified/20 bg-unverified/8 px-3 py-2">
                        <p className="font-mono text-[10px] font-semibold text-unverified">
                          ⚠ Zero-tag agents — {report.zeroTagAgents.length + (report.zeroTagOverflow ?? 0)} agent
                          {(report.zeroTagAgents.length + (report.zeroTagOverflow ?? 0)) === 1 ? '' : 's'} emitted no parseable &lt;agent_finding&gt; tags
                        </p>
                        <p className="mt-0.5 font-mono text-[9px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>
                          {report.zeroTagAgents.join(', ')}
                          {report.zeroTagOverflow && report.zeroTagOverflow > 0
                            ? ` (+${report.zeroTagOverflow} more)`
                            : ''}
                        </p>
                        <p className="mt-1 font-mono text-[9px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
                          Likely a paraphrased relay or HTML-entity-encoded tags. See HANDBOOK invariant #12.
                        </p>
                      </div>
                    )}
                    {(() => {
                      const skipped = (report.warnings ?? []).filter(w => w.code === 'cross_review_skipped');
                      if (skipped.length === 0) return null;
                      const named = skipped.map(w => w.agentId).filter(Boolean) as string[];
                      return (
                        <div className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2">
                          <p className="font-mono text-[10px] font-semibold text-warn">
                            ⚠ Cross-review skipped: {skipped.length} relay agent{skipped.length === 1 ? '' : 's'} failed Phase 2
                          </p>
                          {named.length > 0 && (
                            <p className="mt-0.5 font-mono text-[9px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>
                              {named.join(', ')}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    {(report.crossReviewAssignments || report.crossReviewCoverage) && (() => {
                      // Invert assignments: reviewerId → findingIds
                      const assignments = report.crossReviewAssignments || {};
                      const reviewerEntries = Object.entries(assignments);
                      // Count under-reviewed findings from coverage data
                      const coverage = report.crossReviewCoverage || [];
                      const totalCovered = coverage.length;
                      const underReviewed = coverage.filter(c => c.assigned < c.targetK);
                      // partial_review is now a warning code (spec §4 — legacy
                      // report.partialReview field deleted in PR-C; old reports
                      // mapped at read time).
                      const isPartial = (report.warnings ?? []).some(w => w.code === 'partial_review');
                      return (
                        <details className="mb-3 rounded-md border border-border/30" style={{ background: 'color-mix(in oklch, var(--surface-elev) 30%, transparent)' }}>
                          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 h-section select-none">
                            Cross-Review Assignments
                            {isPartial && (
                              <span className="rounded border border-warn/20 bg-warn/10 px-1.5 py-0.5 font-mono text-[9px] font-bold normal-case tracking-normal text-warn">
                                partial
                              </span>
                            )}
                            <span className="ml-auto font-mono text-[9px] font-normal normal-case tracking-normal" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
                              {reviewerEntries.length} reviewers · {totalCovered} findings
                            </span>
                          </summary>
                          <div className="border-t border-border/20 px-3 pb-3 pt-2 space-y-2">
                            {reviewerEntries.map(([reviewerId, findingIds]) => (
                              <div key={reviewerId} className="flex items-center gap-2">
                                <span
                                  title={reviewerId}
                                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[8px] font-bold"
                                  style={{ color: 'var(--surface)', backgroundColor: agentColor(reviewerId) }}
                                >
                                  {agentInitials(reviewerId)}
                                </span>
                                <span className="font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>{reviewerId}</span>
                                <span className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 40%, transparent)' }}>({findingIds.length})</span>
                                <div className="flex flex-wrap gap-1 ml-1">
                                  {findingIds.map(fid => (
                                    <span key={fid} className="rounded px-1.5 py-0.5 font-mono text-[9px]" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 50%, transparent)', color: 'var(--text-dim)' }}>
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
                        <div className="py-4 text-center text-xs" style={{ color: 'var(--text-dim)' }}>No findings match this filter.</div>
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
            <div className="flex items-center justify-center gap-3 pt-4 font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
              <button
                onClick={() => setDebatePage(p => Math.max(0, p - 1))}
                disabled={clampedDebatePage === 0}
                className="rounded-sm border border-border/40 px-3 py-1 transition hover:bg-accent/10 disabled:opacity-30"
                style={{ background: 'var(--surface-elev)' }}
              >◂ Prev</button>
              <span>Page {clampedDebatePage + 1} of {totalDebatePages}</span>
              <button
                onClick={() => setDebatePage(p => Math.min(totalDebatePages - 1, p + 1))}
                disabled={clampedDebatePage >= totalDebatePages - 1}
                className="rounded-sm border border-border/40 px-3 py-1 transition hover:bg-accent/10 disabled:opacity-30"
                style={{ background: 'var(--surface-elev)' }}
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

            // Per-run filter state (reuses filterByReport keyed by taskId)
            const runFilter = filterByReport[run.taskId] ?? 'all';

            // Filter signals for expanded view
            const filteredSignals = run.signals.filter(sig => {
              if (sig.signal === 'signal_retracted') return false;
              if (runFilter === 'all') return !!TAG_MAP[sig.signal];
              const tag = TAG_MAP[sig.signal];
              return tag && tag.filter === runFilter;
            });

            const isRunRetracted = !!run.retracted;
            return (
              <div
                key={run.taskId + i}
                className={`rounded-md border transition ${isOpen ? 'border-primary/25' : 'border-border'} ${isRunRetracted ? 'opacity-60' : ''}`}
                style={{ background: 'var(--surface-elev)' }}
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
                      <span className="ml-2" style={{ color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }}>— {run.retractionReason}</span>
                    )}
                  </div>
                )}
                {/* Header — clickable */}
                <button
                  aria-expanded={isOpen}
                  onClick={() => { const opening = !isOpen; setExpandedId(opening ? run.taskId : null); if (opening) { setFilterByReport(prev => ({ ...prev, [run.taskId]: 'all' })); } }}
                  className="flex w-full items-center p-3 text-left transition hover:bg-accent/10"
                >
                  <span
                    className="mr-3 font-mono text-xs transition"
                    style={{ color: isOpen ? 'var(--ink)' : 'var(--text-dim)', fontWeight: isOpen ? 600 : 400 }}
                  >
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>{run.taskId}</span>
                        <span className={`font-mono text-sm font-semibold ${isRunRetracted ? 'line-through decoration-disputed/40' : ''}`} style={{ color: 'var(--text)' }}>{runTotal} findings</span>
                        <div className="flex gap-1.5">
                          {run.agents.slice(0, 4).map((a) => (
                            <span key={a} className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]" style={{ background: 'var(--surface-sunk)', color: 'var(--text-dim)' }}>
                              {a.split('-').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                            </span>
                          ))}
                          {run.agents.length > 4 && (
                            <span className="font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>+{run.agents.length - 4}</span>
                          )}
                        </div>
                      </div>
                      <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{timeAgo(run.timestamp)}</span>
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
                          onClick={() => setFilterByReport(prev => ({ ...prev, [run.taskId]: chip.key }))}
                          className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-semibold transition ${runFilter === chip.key ? chip.activeCls : chip.cls} hover:opacity-80`}
                          style={runFilter === chip.key ? chip.activeStyle : chip.inactiveStyle}
                          {...(chip.tooltip ? { 'data-tooltip': chip.tooltip } : {})}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>

                    {/* Findings list */}
                    {filteredSignals.length === 0 ? (
                      <div className="py-4 text-center text-xs" style={{ color: 'var(--text-dim)' }}>No findings match this filter.</div>
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
                                <span className="text-xs [&_.cite-file]:rounded [&_.cite-file]:bg-[color-mix(in_oklch,var(--cite-file)_10%,transparent)] [&_.cite-file]:px-1 [&_.cite-file]:font-mono [&_.cite-file]:text-[var(--cite-file)] [&_.cite-fn]:rounded [&_.cite-fn]:bg-[color-mix(in_oklch,var(--cite-fn)_10%,transparent)] [&_.cite-fn]:px-1 [&_.cite-fn]:font-mono [&_.cite-fn]:text-[var(--cite-fn)]" style={{ color: 'var(--text-dim)' }}>
                                  <span className="finding-md" dangerouslySetInnerHTML={{ __html: renderFindingMarkdown(sig.evidence || '') }} />
                                </span>
                                <span className="ml-2 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
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
