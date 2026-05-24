import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import type { ViolationEntry, ViolationsResponse } from '@/lib/types';

const PAGE_SIZE = 25;

function CommitCell({ commits }: { commits: string[] }) {
  const [expanded, setExpanded] = useState(false);

  if (commits.length === 0) {
    return <span style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>—</span>;
  }

  const first = commits[0];
  // Extract just the subject (after sha prefix if present)
  const subject = first.includes(' ') ? first.slice(first.indexOf(' ') + 1) : first;
  const overflow = commits.length - 1;

  return (
    <span className="font-mono text-[11px]">
      <span style={{ color: 'var(--text)' }}>{subject}</span>
      {overflow > 0 && (
        <>
          {' '}
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="font-mono text-[10px] underline"
            style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}
          >
            {expanded ? '(collapse)' : `(+${overflow} more)`}
          </button>
          {expanded && (
            <ul className="mt-1 space-y-0.5 pl-2">
              {commits.slice(1).map((c, i) => {
                const s = c.includes(' ') ? c.slice(c.indexOf(' ') + 1) : c;
                return (
                  <li key={i} className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }}>
                    {s}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </span>
  );
}

function ViolationRow({ row }: { row: ViolationEntry }) {
  const preSha = row.preSha.slice(0, 8);
  const postSha = row.postSha.slice(0, 8);

  return (
    <tr className="border-t border-border/20 align-top transition-colors hover:bg-accent/20">
      <td className="whitespace-nowrap py-3 pl-4 pr-4 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }}>
        {timeAgo(row.detectedAt)}
      </td>
      <td className="max-w-[160px] truncate whitespace-nowrap py-3 pr-4">
        <a
          href={`/dashboard/agent/${encodeURIComponent(row.agentId)}`}
          className="font-mono text-[11px] hover:underline"
          style={{ color: 'var(--text)' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text)')}
        >
          {row.agentId}
        </a>
      </td>
      <td className="whitespace-nowrap py-3 pr-4 font-mono text-[10px]">
        <span style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>{preSha}</span>
        <span className="mx-1" style={{ color: 'color-mix(in oklch, var(--text-dim) 40%, transparent)' }}>→</span>
        <span style={{ color: 'var(--text)' }}>{postSha}</span>
      </td>
      <td className="py-3 pr-4">
        <CommitCell commits={row.commits} />
      </td>
    </tr>
  );
}

export function ViolationsPage() {
  const [rows, setRows] = useState<ViolationEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<ViolationsResponse>(`violations?page=${page}&pageSize=${PAGE_SIZE}`)
      .then((res) => {
        if (cancelled) return;
        setRows(res.items ?? []);
        setTotal(res.total ?? 0);
      })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline gap-3">
          <h1 className="h-route">Process Violations</h1>
          {total > 0 && (
            <span className="font-mono text-sm tabular-nums" style={{ color: 'var(--ink-3)' }}>
              {total}
            </span>
          )}
        </div>
        <p className="mt-0.5 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>
          Direct master pushes detected by the ref-allowlist enforcer
        </p>
      </div>

      <div className="overflow-hidden rounded-md border border-border/40" style={{ background: 'color-mix(in oklch, var(--surface-elev) 80%, transparent)' }}>
        {error && (
          <div className="border-b border-border/60 bg-disputed/10 px-3 py-2 font-mono text-[10px] text-disputed">
            {error}
          </div>
        )}

        {!error && (
          <table className="w-full table-fixed text-left">
            <thead>
              <tr className="border-b border-border/40 font-mono text-[10px] uppercase tracking-wider" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 20%, transparent)', color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }}>
                <th className="py-2.5 pl-4 pr-4">When</th>
                <th className="py-2.5 pr-4">Agent</th>
                <th className="py-2.5 pr-4">Commit Range</th>
                <th className="py-2.5 pr-4">Commits</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center font-mono text-[11px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
                    No violations recorded
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.map((row) => (
                <ViolationRow key={`${row.taskId}-${row.detectedAt}`} row={row} />
              ))}
            </tbody>
          </table>
        )}

        <div className="flex items-center justify-between border-t border-border/60 px-3 py-2">
          <span className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>
            {loading
              ? 'loading…'
              : total === 0
                ? 'no violations'
                : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`}
          </span>
          <div className={`flex items-center gap-2 font-mono text-[10px] ${totalPages <= 1 ? 'invisible' : ''}`} style={{ color: 'var(--text-dim)' }}>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="rounded-sm border border-border/40 px-2 py-0.5 transition hover:bg-accent/10 disabled:opacity-30"
              style={{ background: 'var(--surface-elev)' }}
            >
              ◂ Prev
            </button>
            <span className="tabular-nums">{page} / {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="rounded-sm border border-border/40 px-2 py-0.5 transition hover:bg-accent/10 disabled:opacity-30"
              style={{ background: 'var(--surface-elev)' }}
            >
              Next ▸
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
