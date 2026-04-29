import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { href } from '@/lib/router';
import type { ViolationEntry, ViolationsResponse } from '@/lib/types';

const PAGE_SIZE = 25;

function CommitCell({ commits }: { commits: string[] }) {
  const [expanded, setExpanded] = useState(false);

  if (commits.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }

  const first = commits[0];
  // Extract just the subject (after sha prefix if present)
  const subject = first.includes(' ') ? first.slice(first.indexOf(' ') + 1) : first;
  const overflow = commits.length - 1;

  return (
    <span className="font-inter text-[11px]">
      <span className="text-foreground">{subject}</span>
      {overflow > 0 && (
        <>
          {' '}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="font-mono text-[10px] text-muted-foreground/70 underline hover:text-foreground"
          >
            {expanded ? '(collapse)' : `(+${overflow} more)`}
          </button>
          {expanded && (
            <ul className="mt-1 space-y-0.5 pl-2">
              {commits.slice(1).map((c, i) => {
                const s = c.includes(' ') ? c.slice(c.indexOf(' ') + 1) : c;
                return (
                  <li key={i} className="font-mono text-[10px] text-muted-foreground/80">
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
      <td className="whitespace-nowrap py-3 pl-4 pr-4 font-mono text-[10px] text-muted-foreground/80">
        {timeAgo(row.detectedAt)}
      </td>
      <td className="whitespace-nowrap py-3 pr-4">
        <a
          href={href(`/agent/${encodeURIComponent(row.agentId)}`)}
          className="font-mono text-[11px] text-foreground hover:text-primary hover:underline"
        >
          {row.agentId}
        </a>
      </td>
      <td className="whitespace-nowrap py-3 pr-4 font-mono text-[10px]">
        <span className="text-muted-foreground/70">{preSha}</span>
        <span className="mx-1 text-muted-foreground/40">→</span>
        <span className="text-foreground">{postSha}</span>
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
    setLoading(true);
    setError(null);
    api<ViolationsResponse>(`violations?page=${page}&pageSize=${PAGE_SIZE}`)
      .then((res) => {
        setRows(res.items ?? []);
        setTotal(res.total ?? 0);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-mono text-[11px] font-bold uppercase tracking-widest text-foreground">
          Process Violations
          {total > 0 && (
            <span className="ml-2 text-destructive">{total}</span>
          )}
        </h1>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
          Direct master pushes detected by the ref-allowlist enforcer
        </p>
      </div>

      <div className="overflow-hidden rounded-md border border-border/40 bg-card/80">
        {error && (
          <div className="border-b border-border/60 bg-disputed/10 px-3 py-2 font-mono text-[10px] text-disputed">
            {error}
          </div>
        )}

        {!error && (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border/40 bg-muted/20 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
                <th className="py-2.5 pl-4 pr-4">When</th>
                <th className="py-2.5 pr-4">Agent</th>
                <th className="py-2.5 pr-4">Commit Range</th>
                <th className="py-2.5 pr-4">Commits</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center font-mono text-[11px] text-muted-foreground/50">
                    No violations recorded
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center font-mono text-[10px] text-muted-foreground/50">
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
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {loading
              ? 'loading…'
              : total === 0
                ? 'no violations'
                : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`}
          </span>
          <div className={`flex items-center gap-2 font-mono text-[10px] text-muted-foreground ${totalPages <= 1 ? 'invisible' : ''}`}>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="rounded-sm border border-border/40 bg-card px-2 py-0.5 transition hover:bg-accent/50 disabled:opacity-30"
            >
              ◂ Prev
            </button>
            <span className="tabular-nums">{page} / {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="rounded-sm border border-border/40 bg-card px-2 py-0.5 transition hover:bg-accent/50 disabled:opacity-30"
            >
              Next ▸
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
