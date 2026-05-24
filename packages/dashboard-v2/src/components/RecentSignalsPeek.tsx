import { useEffect, useState } from 'react';
import type React from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { navigate } from '@/lib/router';
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
  unique_unconfirmed: 'var(--info)',
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

// Map severity → confidence /5 for the CONF column.
const SEVERITY_CONF: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
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
          {lastHour > 0 && (
            <span className="font-mono text-[11px]" style={{ color: 'var(--accent)' }}>
              +{lastHour} in last hour
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => navigate('/signals')}
          className="font-mono text-[11px] hover:underline"
          style={{ color: 'var(--text-dim)' }}
        >
          all signals →
        </button>
      </header>

      <div className="rounded-lg border border-border" style={{ background: 'var(--surface-elev)' }}>
        {err && <p className="px-4 py-3 text-xs" style={{ color: 'var(--text-dim)' }}>unavailable</p>}
        {!err && items && items.length === 0 && (
          <p className="px-4 py-3 text-xs" style={{ color: 'var(--text-dim)' }}>no signals recorded</p>
        )}
        {!err && items && items.length > 0 && (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="h-section py-2 pl-4 pr-3 text-left" style={{ fontSize: 10, width: 80 }}>time</th>
                <th className="h-section py-2 pr-3 text-left" style={{ fontSize: 10, width: 160 }}>verdict</th>
                <th className="h-section py-2 pr-3 text-left" style={{ fontSize: 10, width: 180 }}>agent</th>
                <th className="h-section py-2 pr-3 text-left" style={{ fontSize: 10 }}>finding</th>
                <th className="h-section py-2 pl-3 pr-4 text-right" style={{ fontSize: 10, width: 60 }}>conf</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => {
                const tickColor = s.severity ? SEVERITY_TICK_COLOR[s.severity] : 'transparent';
                const verdictColor = VERDICT_COLOR[s.signal] ?? 'var(--ink-2)';
                const verdictLabel = LABELS[s.signal] ?? s.signal;
                const conf = s.severity ? SEVERITY_CONF[s.severity] : 1;
                return (
                  <tr key={`${s.timestamp}-${i}`} className="border-b border-border/40 last:border-b-0">
                    <td className="py-2.5 pl-4 pr-3 align-middle font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                      {timeAgo(s.timestamp)}
                    </td>
                    <td className="py-2.5 pr-3 align-middle">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
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
                    <td className="py-2.5 pr-3 align-middle text-[12px]" style={{ color: 'var(--text)', lineHeight: 1.45 }}>
                      {renderFinding(truncate(s.evidence ?? '', 120))}
                    </td>
                    <td className="py-2.5 pl-3 pr-4 align-middle text-right font-mono text-[12px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                      {conf}/5
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
