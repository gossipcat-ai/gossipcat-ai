import { useEffect, useState } from 'react';
import type React from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { ErrorChip } from './ErrorChip';
import type { SignalEntry } from '@/lib/types';

interface SignalsResponse {
  items: SignalEntry[];
  total: number;
}

const LABELS: Record<string, string> = {
  agreement: 'confirmed',
  consensus_verified: 'confirmed',
  unique_confirmed: 'unique',
  unique_unconfirmed: 'unique?',
  disagreement: 'disputed',
  hallucination_caught: 'hallucination',
  new_finding: 'new',
  unverified: 'unverified',
};

// DESIGN.md Step 8 — semantic verdict color (small-caps Geist via .h-section)
const VERDICT_COLOR: Record<string, string> = {
  agreement: 'var(--ok)',
  consensus_verified: 'var(--ok)',
  disagreement: 'var(--bad)',
  hallucination_caught: 'var(--bad)',
  unique_confirmed: 'var(--info)',
  unique_unconfirmed: 'var(--warn)',
  new_finding: 'var(--info)',
  unverified: 'var(--info)',
};

// DESIGN.md Step 8 — severity tick palette
const SEVERITY_TICK_COLOR: Record<string, string> = {
  critical: 'var(--bad)',
  high: 'var(--warn)',
  medium: 'var(--info)',
  low: 'var(--ink-3)',
};


function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Wrap backtick spans in code-inline styling, matching the mockup. */
function renderFinding(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      return (
        <code
          key={i}
          style={{
            background: 'color-mix(in oklch, var(--ink) 6%, transparent)',
            padding: '0 4px',
            borderRadius: 3,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--ink)',
          }}
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

export function RecentSignalsPeek() {
  const [items, setItems] = useState<SignalEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Pull 7 items so the table shows roughly the mockup's row count.
    api<SignalsResponse>('signals?limit=7')
      .then((r) => setItems(r.items ?? []))
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  // "+N in last hour" delta — recency callout per mockup.
  const lastHour = items
    ? items.filter((s) => Date.now() - Date.parse(s.timestamp) < 3600_000).length
    : 0;

  return (
    <section>
      {/* Section header — small-caps title + recency callout + 'all signals →' */}
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h3 className="h-section">Signal stream</h3>
          <span
            className="font-mono text-[11px]"
            style={{ color: 'var(--info)', visibility: lastHour === 0 ? 'hidden' : 'visible' }}
          >
            +{lastHour} in last hour
          </span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/signals')}
          className="font-mono text-[11px] hover:underline"
          style={{ color: 'var(--text-dim)' }}
        >
          all signals →
        </button>
        {err && <ErrorChip message={err} className="ml-2" />}
      </header>

      <div className="rounded-lg border border-border" style={{ background: 'var(--surface-elev)' }}>
        {/* Loading skeleton — 5 fake rows, no animate-pulse per ActivityWaterfall precedent */}
        {!err && items === null && (
          <div aria-busy="true">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 pl-4 pr-3" style={{ width: 80 }}>
                    <div className="h-2 w-8 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
                  </th>
                  <th className="py-2 pr-3" style={{ width: 160 }}>
                    <div className="h-2 w-12 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
                  </th>
                  <th className="py-2 pr-3" style={{ width: 180 }}>
                    <div className="h-2 w-10 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
                  </th>
                  <th className="py-2 pr-4">
                    <div className="h-2 w-14 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/40 last:border-b-0">
                    <td className="py-2.5 pl-4 pr-3">
                      <div className="h-2.5 w-10 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <div style={{ width: 3, height: 14, background: 'var(--border)', opacity: 0.4, borderRadius: 1, flexShrink: 0 }} />
                        <div className="h-2.5 w-14 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="h-2.5 w-24 rounded" style={{ background: 'var(--border)', opacity: 0.4 }} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="h-2.5 rounded" style={{ background: 'var(--border)', opacity: 0.4, width: '75%' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* DESIGN.md error contract — when err is set we render the cached
            items (already preserved in state, since setItems is only called
            on a successful fetch) dimmed at 50% so the operator still sees
            their context. The full error reason lives in the header ErrorChip. */}
        {!err && items && items.length === 0 && (
          <p className="px-4 py-3 text-xs" style={{ color: 'var(--text-dim)' }}>no signals recorded</p>
        )}
        {err && (!items || items.length === 0) && (
          <p className="px-4 py-3 text-xs" style={{ color: 'var(--text-dim)' }}>no cached signals to display</p>
        )}
        {items && items.length > 0 && (
          <table className="w-full" style={err ? { opacity: 0.5 } : undefined}>
            <thead>
              <tr className="border-b border-border">
                <th className="h-section py-2 pl-4 pr-3 text-left" style={{ fontSize: 10, width: 80 }}>time</th>
                <th className="h-section py-2 pr-3 text-left" style={{ fontSize: 10, width: 160 }}>verdict</th>
                <th className="h-section py-2 pr-3 text-left" style={{ fontSize: 10, width: 180 }}>agent</th>
                <th className="h-section py-2 pr-4 text-left" style={{ fontSize: 10 }}>finding</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => {
                const tickColor = s.severity ? SEVERITY_TICK_COLOR[s.severity] : 'transparent';
                const verdictColor = VERDICT_COLOR[s.signal] ?? 'var(--ink-2)';
                const verdictLabel = LABELS[s.signal] ?? s.signal;
                return (
                  <tr key={`${s.timestamp}-${i}`} className="border-b border-border/40 last:border-b-0">
                    <td className="py-2.5 pl-4 pr-3 align-middle font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                      {timeAgo(s.timestamp)}
                    </td>
                    <td className="py-2.5 pr-3 align-middle">
                      <div className="flex items-center gap-2">
                        <span
                          role="img"
                          aria-label={s.severity ? `severity: ${s.severity}` : 'severity: unspecified'}
                          style={{ display: 'inline-block', width: 3, height: 14, background: tickColor, borderRadius: 1, flexShrink: 0 }}
                          title={s.severity ?? ''}
                        />
                        <span className="h-section truncate" style={{ color: verdictColor, fontSize: 11 }} title={verdictLabel}>
                          {verdictLabel}
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 align-middle font-mono text-[12px]" style={{ color: 'var(--text-dim)' }}>
                      <span className="truncate">{s.agentId}</span>
                    </td>
                    <td className="py-2.5 pr-4 align-middle text-[12px]" style={{ color: 'var(--text)', lineHeight: 1.45 }}>
                      {renderFinding(truncate(s.evidence ?? '', 120))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
