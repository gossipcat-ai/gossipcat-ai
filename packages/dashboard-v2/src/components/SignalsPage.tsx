import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { href } from '@/lib/router';
import { SignalFilterRail, type SignalFilters } from './SignalFilterRail';
import { FindingDetailDrawer } from './FindingDetailDrawer';
import type { SignalEntry } from '@/lib/types';

interface SignalsResponse {
  items: SignalEntry[];
  total: number;
}

interface AgentsListItem { id: string }

const EMPTY_FILTERS: SignalFilters = {
  agents: [],
  signals: [],
};

const SIGNAL_TYPES = [
  'agreement',
  'consensus_verified',
  'unique_confirmed',
  'unique_unconfirmed',
  'disagreement',
  'hallucination_caught',
  'new_finding',
  'unverified',
  'impl_test_pass',
  'impl_test_fail',
  'impl_typecheck_pass',
  'impl_typecheck_fail',
  'task_completed',
  'tool_turns',
  'format_compliance',
];

const SIGNAL_LABELS: Record<string, string> = {
  agreement: 'Agreement',
  consensus_verified: 'Consensus verified',
  unique_confirmed: 'Unique (confirmed)',
  unique_unconfirmed: 'Unique (unconfirmed)',
  disagreement: 'Disagreement',
  hallucination_caught: 'Hallucination',
  new_finding: 'New finding',
  unverified: 'Unverified',
  impl_test_pass: 'Test pass',
  impl_test_fail: 'Test fail',
  impl_typecheck_pass: 'Typecheck pass',
  impl_typecheck_fail: 'Typecheck fail',
  impl_peer_approved: 'Peer approved',
  impl_peer_rejected: 'Peer rejected',
  boundary_escape: 'Boundary escape',
};

// DESIGN.md Step 8 — semantic verdict color per signal type. Applied as inline
// color on a .h-section span (small-caps Geist) so verdict text reads as a
// section-label, not all-caps mono. Confirmed = --ok green, disputed/
// hallucination = --bad rose, unique/new_finding/unverified = --info teal.
// Operational pass/fail signals (impl_test_*, impl_typecheck_*) map onto the
// same ok/bad axis. boundary_escape = --bad (security violation).
const VERDICT_COLOR: Record<string, string> = {
  agreement: 'var(--ok)',
  consensus_verified: 'var(--ok)',
  impl_test_pass: 'var(--ok)',
  impl_typecheck_pass: 'var(--ok)',
  impl_peer_approved: 'var(--ok)',
  disagreement: 'var(--bad)',
  hallucination_caught: 'var(--bad)',
  impl_test_fail: 'var(--bad)',
  impl_typecheck_fail: 'var(--bad)',
  impl_peer_rejected: 'var(--bad)',
  boundary_escape: 'var(--bad)',
  unique_confirmed: 'var(--info)',
  unique_unconfirmed: 'var(--info)',
  new_finding: 'var(--info)',
  unverified: 'var(--info)',
};

// DESIGN.md Step 8 — severity-tick semantic palette. Single color per severity
// (no opacity ramp) so the leftmost 6px bar reads severity at a glance:
//   critical → --bad rose · high → --warn amber · medium → --info teal ·
//   low → --ink-3 neutral. No --accent leaks; no Tailwind raw colors.
const SEVERITY_TICK_COLOR: Record<string, string> = {
  critical: 'var(--bad)',
  high: 'var(--warn)',
  medium: 'var(--info)',
  low: 'var(--ink-3)',
};

const PAGE_SIZE = 100;

function hydrateFromURL(): { filters: SignalFilters; hadAny: boolean } {
  if (typeof window === 'undefined') return { filters: EMPTY_FILTERS, hadAny: false };
  const q = new URLSearchParams(window.location.search);
  const signals = q.getAll('signal').filter(Boolean);
  const agent = q.get('agent');
  const counterpart = q.get('counterpart') ?? undefined;
  const category = q.get('category') ?? undefined;
  const rawSeverity = q.get('severity');
  const severity = (rawSeverity === 'critical' || rawSeverity === 'high' || rawSeverity === 'medium' || rawSeverity === 'low')
    ? rawSeverity
    : undefined;
  const since = q.get('since') ?? undefined;
  const until = q.get('until') ?? undefined;
  const consensusId = q.get('consensus_id') ?? undefined;
  const findingId = q.get('finding_id') ?? undefined;
  const rawSource = q.get('source');
  const source = (rawSource === 'manual' || rawSource === 'impl' || rawSource === 'meta' || rawSource === 'auto-provisional')
    ? rawSource
    : undefined;

  const hasAny = signals.length > 0 || agent || counterpart || category || severity ||
    since || until || consensusId || findingId || source;
  if (!hasAny) return { filters: EMPTY_FILTERS, hadAny: false };

  return {
    filters: {
      agents: agent ? [agent] : [],
      signals,
      counterpart,
      category,
      severity,
      since,
      until,
      consensusId,
      findingId,
      source,
    },
    hadAny: true,
  };
}

function buildQuery(filters: SignalFilters, offset: number, limit = PAGE_SIZE): URLSearchParams {
  const q = new URLSearchParams();
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  if (filters.agents.length === 1) q.set('agent', filters.agents[0]);
  if (filters.counterpart) q.set('counterpart', filters.counterpart);
  for (const s of filters.signals) q.append('signal', s);
  if (filters.category) q.set('category', filters.category);
  if (filters.severity) q.set('severity', filters.severity);
  if (filters.since) q.set('since', filters.since);
  if (filters.until) q.set('until', filters.until);
  if (filters.consensusId) q.set('consensus_id', filters.consensusId);
  if (filters.findingId) q.set('finding_id', filters.findingId);
  if (filters.source) q.set('source', filters.source);
  return q;
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function SignalsPage() {
  const [{ filters: initialFilters, hadAny: hadAnyURLParams }] = useState(hydrateFromURL);
  const [filters, setFilters] = useState<SignalFilters>(initialFilters);
  const [rows, setRows] = useState<SignalEntry[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>([]);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerConsensusId, setDrawerConsensusId] = useState<string | null>(null);
  const [drawerFindingId, setDrawerFindingId] = useState<string | null>(null);

  // Debounce filter changes (250ms) to avoid one request per keystroke.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestReqId = useRef(0);

  const doFetch = useCallback(
    async (f: SignalFilters, pageIdx: number) => {
      const reqId = ++latestReqId.current;
      setLoading(true);
      setError(null);
      try {
        const q = buildQuery(f, pageIdx * PAGE_SIZE);
        const res = await api<SignalsResponse>(`signals?${q.toString()}`);
        // Guard against racing older requests writing over newer results.
        if (reqId !== latestReqId.current) return;
        setRows(res.items ?? []);
        setTotal(res.total ?? 0);
      } catch (e) {
        if (reqId !== latestReqId.current) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
      } finally {
        if (reqId === latestReqId.current) setLoading(false);
      }
    },
    []
  );

  // Load the full agent list once on mount so the filter rail shows every agent,
  // not just those that appear in the current signal window.
  useEffect(() => {
    api<AgentsListItem[]>('agents')
      .then((list) => {
        const ids = (list ?? []).map((a) => a.id).filter(Boolean).sort();
        if (ids.length > 0) setAgents(ids);
      })
      .catch(() => { /* leave empty; page still works */ });
  }, []);

  // Reset to page 0 whenever filters change
  useEffect(() => {
    setPage(0);
  }, [filters]);

  // Debounced fetch on filter / page change
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      doFetch(filters, page);
    }, 250);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [filters, page, doFetch]);

  const onFilterChange = useCallback((patch: Partial<SignalFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);

  // Diagnosis 3: hide the 260px filter rail on first-glance empty states so
  // operators land on data, not chrome. Keep it visible when there's data,
  // when filters are active (need to clear them), or while loading (no flash).
  const showRail = total > 0 || hadAnyURLParams || loading;

  const openDrawer = (consensusId?: string, findingId?: string) => {
    if (!consensusId || !findingId) return;
    setDrawerConsensusId(consensusId);
    setDrawerFindingId(findingId);
    setDrawerOpen(true);
  };

  const headerLabel = useMemo(() => {
    const parts: string[] = [];
    if (filters.agents.length) parts.push(`${filters.agents.length} agents`);
    if (filters.signals.length) parts.push(`${filters.signals.length} signals`);
    if (filters.severity) parts.push(filters.severity);
    if (filters.source) parts.push(filters.source);
    if (filters.since || filters.until) parts.push('time window');
    return parts.length ? parts.join(' · ') : 'all signals';
  }, [filters]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="h-route">Signals</h1>
          <p className="mt-0.5 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>Scored events emitted by agents during consensus review.</p>
          <p className="mt-0.5 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>
            {headerLabel} — showing {rows.length} of {total}
          </p>
        </div>
      </div>

      {hadAnyURLParams && (
        <div className="rounded-md border border-border/40 px-3 py-2 font-mono text-[10px]" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 30%, transparent)', color: 'var(--text-dim)' }}>
          Filtered view — {filters.signals.length} signal type{filters.signals.length !== 1 ? 's' : ''}{filters.agents.length > 0 ? ` · ${filters.agents.length} agent${filters.agents.length !== 1 ? 's' : ''}` : ''}{filters.severity ? ` · severity: ${filters.severity}` : ''}{filters.source ? ` · source: ${filters.source}` : ''}. <a href={href('/signals')} style={{ color: 'var(--accent)' }}>Clear filters</a>
        </div>
      )}

      <div className={`grid grid-cols-1 gap-4 ${showRail ? 'lg:grid-cols-[260px_1fr]' : ''} lg:items-start`}>
        {showRail && (
          <div className={hadAnyURLParams ? 'opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100' : undefined}>
            <SignalFilterRail
              filters={filters}
              onChange={onFilterChange}
              agents={agents}
              signalTypes={SIGNAL_TYPES}
            />
          </div>
        )}

        <section className="min-w-0 overflow-hidden rounded-md border border-border/60" style={{ background: 'color-mix(in oklch, var(--surface-elev) 70%, transparent)' }}>
          {error && (
            <div
              className="border-b border-border/60 px-3 py-2 font-mono text-[10px]"
              style={{
                color: 'var(--bad)',
                background: 'color-mix(in oklch, var(--bad) 10%, transparent)',
              }}
            >
              {error}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10px]">
              <thead>
                <tr className="h-section border-b border-border/60 text-left" style={{ color: 'color-mix(in oklch, var(--ink-2) 80%, transparent)' }}>
                  {/* Leftmost severity-tick column — 6px bar, no header label */}
                  <th className="w-[6px] p-0" aria-label="severity" />
                  <th className="px-2 py-1.5">time</th>
                  <th className="px-2 py-1.5">agent</th>
                  <th className="px-2 py-1.5">verdict</th>
                  <th className="px-2 py-1.5">finding</th>
                  <th className="px-2 py-1.5" data-tooltip="The other agent in this signal — e.g. the peer who agreed or disputed">counterpart</th>
                  <th className="px-2 py-1.5" data-tooltip="Finding ID — click row to open finding detail">id</th>
                  <th className="px-2 py-1.5">consensus</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={8} className="px-2 py-8 text-center font-mono" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
                      no signals match these filters
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => {
                  const canOpen = !!(r.consensusId && r.findingId);
                  const tickColor = r.severity ? SEVERITY_TICK_COLOR[r.severity] : 'transparent';
                  const verdictColor = VERDICT_COLOR[r.signal] ?? 'var(--ink-2)';
                  const verdictLabel = SIGNAL_LABELS[r.signal] ?? r.signal;
                  return (
                    <tr
                      key={`${r.timestamp}-${r.agentId}-${i}`}
                      className={`border-b border-border/30 ${canOpen ? 'cursor-pointer transition-colors' : ''}`}
                      style={canOpen ? { ['--row-hover-bg' as string]: 'color-mix(in oklch, var(--surface-sunk) 40%, transparent)' } : undefined}
                      // Keyboard-accessible activation: when canOpen, treat the row as
                      // an interactive button (Enter/Space → openDrawer). Without this,
                      // keyboard/SR users couldn't reach the drawer.
                      role={canOpen ? 'button' : undefined}
                      tabIndex={canOpen ? 0 : undefined}
                      aria-label={canOpen ? `View finding ${r.findingId ?? ''}` : undefined}
                      onMouseEnter={(e) => {
                        if (canOpen) e.currentTarget.style.background = 'color-mix(in oklch, var(--surface-sunk) 40%, transparent)';
                      }}
                      onMouseLeave={(e) => {
                        if (canOpen) e.currentTarget.style.background = '';
                      }}
                      onClick={() => canOpen && openDrawer(r.consensusId, r.findingId)}
                      onKeyDown={(e) => {
                        if (canOpen && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          openDrawer(r.consensusId, r.findingId);
                        }
                      }}
                    >
                      {/* Severity tick — full-bleed left bar, semantic color */}
                      <td
                        className="p-0"
                        style={{ background: tickColor, width: 6 }}
                        title={r.severity ?? 'no severity'}
                      />
                      <td className="whitespace-nowrap px-2 py-1 font-mono tabular-nums" style={{ color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }} title={r.timestamp}>{timeAgo(r.timestamp)}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono" style={{ color: 'var(--text)' }}>{r.agentId}</td>
                      {/* Verdict — small-caps Geist via .h-section, color is semantic */}
                      <td className="whitespace-nowrap px-2 py-1">
                        <span className="h-section" style={{ color: verdictColor, fontSize: 11 }}>{verdictLabel}</span>
                      </td>
                      {/* Finding/evidence — JetBrains Mono code-inline treatment */}
                      <td className="max-w-[320px] truncate px-2 py-1" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.45, color: 'var(--text)' }} title={r.evidence}>
                        {truncate(r.evidence, 80)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono" style={{ color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }}>{r.counterpartId ?? '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }} title={r.findingId}>
                        {r.findingId ? truncate(r.findingId, 24) : '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }} title={r.consensusId}>
                        {r.consensusId ? truncate(r.consensusId, 16) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-border/60 px-3 py-2">
            <span className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>
              {loading
                ? 'loading…'
                : `${clampedPage * PAGE_SIZE + 1}–${clampedPage * PAGE_SIZE + rows.length} of ${total}`}
            </span>
            <div className="flex items-center gap-2 font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={clampedPage === 0 || loading}
                className="rounded-sm border border-border/40 px-2 py-0.5 transition hover:bg-[color-mix(in_oklch,var(--surface-sunk)_50%,transparent)] disabled:opacity-30"
                style={{ background: 'var(--surface-elev)' }}
              >◂ Prev</button>
              <span className="tabular-nums">
                {clampedPage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={clampedPage >= totalPages - 1 || loading}
                className="rounded-sm border border-border/40 px-2 py-0.5 transition hover:bg-[color-mix(in_oklch,var(--surface-sunk)_50%,transparent)] disabled:opacity-30"
                style={{ background: 'var(--surface-elev)' }}
              >Next ▸</button>
            </div>
          </div>
        </section>
      </div>

      <FindingDetailDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        consensusId={drawerConsensusId}
        findingId={drawerFindingId}
      />
    </div>
  );
}
