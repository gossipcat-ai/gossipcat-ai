import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { href } from '@/lib/router';
import type { ViolationsResponse } from '@/lib/types';

export function ViolationsCard() {
  const [data, setData] = useState<ViolationsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ViolationsResponse>('violations?pageSize=1')
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => { if (!cancelled) setErr(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, []);

  const total = data?.total ?? 0;
  const latest = data?.items?.[0] ?? null;
  const hasViolations = total > 0;

  return (
    <div
      className={`rounded-lg border ${hasViolations ? 'border-destructive/30 bg-destructive/10' : 'border-border'}`}
      style={hasViolations ? undefined : { background: 'color-mix(in oklch, var(--surface-sunk) 20%, transparent)' }}
    >
      <div
        className={`flex items-center justify-between border-b px-3.5 py-3 ${
          hasViolations
            ? 'border-destructive/20 bg-destructive/[0.06]'
            : 'border-border/40'
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded-sm font-mono text-[11px] font-bold ${hasViolations ? 'bg-destructive/15 text-destructive' : ''}`}
            style={hasViolations ? undefined : { background: 'var(--surface-sunk)', color: 'var(--text-dim)' }}
          >
            !
          </span>
          <span
            className={`min-w-0 truncate font-mono text-[11px] font-bold uppercase tracking-widest ${hasViolations ? 'text-destructive' : ''}`}
            style={hasViolations ? undefined : { color: 'var(--text-dim)' }}
          >
            Process Violations
          </span>
        </div>
        {hasViolations && (
          <span className="shrink-0 rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 font-mono text-xs font-bold text-destructive">
            {total}
          </span>
        )}
      </div>

      <div className="min-h-[52px] px-3.5 py-3">
        {err && (
          <p className="font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
            failed to load violation data
          </p>
        )}

        {!err && !data && (
          <p className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>Loading…</p>
        )}

        {!err && data && !hasViolations && (
          <p className="font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>
            No violations detected
          </p>
        )}

        {!err && data && hasViolations && (
          <>
            <p className="font-mono text-[11px]" style={{ color: 'var(--text)' }}>
              {total} direct master push{total === 1 ? '' : 'es'} detected
            </p>
            {latest && (
              <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
                <span className="shrink-0">Most recent:</span>
                <span className="truncate" style={{ color: 'var(--text)' }}>{latest.agentId}</span>
                <span className="shrink-0" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>{timeAgo(latest.detectedAt)}</span>
              </div>
            )}
          </>
        )}

        {!err && data && (
          <div className="mt-2 text-right">
            <a
              href={href('/violations')}
              className={`font-mono text-[10px] transition hover:underline ${hasViolations ? 'text-destructive' : ''}`}
              style={hasViolations ? undefined : { color: 'var(--text-dim)' }}
            >
              View all →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
