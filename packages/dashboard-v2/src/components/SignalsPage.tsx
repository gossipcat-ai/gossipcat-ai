import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { SignalFilterRail, type SignalFilters } from './SignalFilterRail';
import { FindingDetailDrawer } from './FindingDetailDrawer';
import type { SignalEntry } from '@/lib/types';

interface SignalsResponse {
  items: SignalEntry[];
  total: number;
  nextCursor?: string;
}

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

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-disputed text-disputed-foreground',
  high: 'bg-disputed/70 text-disputed-foreground',
  medium: 'bg-unique/70 text-unique-foreground',
  low: 'bg-muted text-muted-foreground',
};

function buildQuery(filters: SignalFilters, cursor?: string, limit = 100): URLSearchParams {
  const q = new URLSearchParams();
  q.set('limit', String(limit));
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
  if (cursor) q.set('cursor', cursor);
  return q;
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function SignalsPage() {
  const [filters, setFilters] = useState<SignalFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<SignalEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
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
    async (f: SignalFilters, cursor?: string, append = false) => {
      const reqId = ++latestReqId.current;
      setLoading(true);
      setError(null);
      try {
        const q = buildQuery(f, cursor);
        const res = await api<SignalsResponse>(`signals?${q.toString()}`);
        // Guard against racing older requests writing over newer results.
        if (reqId !== latestReqId.current) return;
        setRows((prev) => (append ? [...prev, ...(res.items ?? [])] : res.items ?? []));
        setNextCursor(res.nextCursor);
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

  // Debounced reset-fetch on filter change
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      doFetch(filters, undefined, false);
    }, 250);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [filters, doFetch]);

  // Derive agent list from returned rows so the filter rail self-populates as
  // the user browses. (A dedicated /agents call would be nicer, but this
  // keeps the page self-contained per the spec.)
  useEffect(() => {
    const seen = new Set<string>(agents);
    for (const r of rows) {
      if (r.agentId) seen.add(r.agentId);
      if (r.counterpartId) seen.add(r.counterpartId);
    }
    const next = Array.from(seen).sort();
    if (next.length !== agents.length) setAgents(next);
  }, [rows, agents]);

  const onFilterChange = useCallback((patch: Partial<SignalFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const onLoadMore = useCallback(() => {
    if (!nextCursor || loading) return;
    doFetch(filters, nextCursor, true);
  }, [nextCursor, loading, filters, doFetch]);

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
          <h1 className="font-mono text-sm font-bold uppercase tracking-widest text-primary">Signals</h1>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
            {headerLabel} — showing {rows.length} of {total}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr] lg:items-start">
        <SignalFilterRail
          filters={filters}
          onChange={onFilterChange}
          agents={agents}
          signalTypes={SIGNAL_TYPES}
        />

        <section className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-card/70">
          {error && (
            <div className="border-b border-border/60 bg-disputed/10 px-3 py-2 font-mono text-[10px] text-disputed">
              {error}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[10px]">
              <thead>
                <tr className="border-b border-border/60 text-left text-muted-foreground/70">
                  <th className="px-2 py-1.5 font-semibold uppercase tracking-widest">Time</th>
                  <th className="px-2 py-1.5 font-semibold uppercase tracking-widest">Agent</th>
                  <th className="px-2 py-1.5 font-semibold uppercase tracking-widest">Signal</th>
                  <th className="px-2 py-1.5 font-semibold uppercase tracking-widest">Counterpart</th>
                  <th className="px-2 py-1.5 font-semibold uppercase tracking-widest">Sev</th>
                  <th className="px-2 py-1.5 font-semibold uppercase tracking-widest">Finding</th>
                  <th className="px-2 py-1.5 font-semibold uppercase tracking-widest">Consensus</th>
                  <th className="px-2 py-1.5 font-semibold uppercase tracking-widest">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={8} className="px-2 py-8 text-center text-muted-foreground/50">
                      no signals match these filters
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => {
                  const canOpen = !!(r.consensusId && r.findingId);
                  return (
                    <tr
                      key={`${r.timestamp}-${r.agentId}-${i}`}
                      className={`border-b border-border/30 ${canOpen ? 'cursor-pointer hover:bg-muted/30' : ''}`}
                      onClick={() => canOpen && openDrawer(r.consensusId, r.findingId)}
                    >
                      <td className="whitespace-nowrap px-2 py-1 text-muted-foreground/80" title={r.timestamp}>{timeAgo(r.timestamp)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-foreground">{r.agentId}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-foreground">{r.signal}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-muted-foreground/80">{r.counterpartId ?? '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1">
                        {r.severity ? (
                          <span className={`rounded px-1 py-0.5 text-[9px] uppercase ${SEVERITY_BADGE[r.severity] ?? 'bg-muted'}`}>
                            {r.severity}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-muted-foreground/70" title={r.findingId}>
                        {r.findingId ? truncate(r.findingId, 24) : '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-muted-foreground/70" title={r.consensusId}>
                        {r.consensusId ? truncate(r.consensusId, 16) : '—'}
                      </td>
                      <td className="max-w-[300px] truncate px-2 py-1 text-muted-foreground/80" title={r.evidence}>
                        {truncate(r.evidence, 80)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-border/60 px-3 py-2">
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {loading ? 'loading…' : `${rows.length} rows`}
            </span>
            <button
              type="button"
              className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-foreground hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!nextCursor || loading}
              onClick={onLoadMore}
            >
              {nextCursor ? 'Load more' : 'End of results'}
            </button>
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
