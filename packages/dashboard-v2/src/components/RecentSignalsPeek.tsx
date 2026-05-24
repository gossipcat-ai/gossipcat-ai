import { useEffect, useState } from 'react';
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

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function RecentSignalsPeek() {
  const [items, setItems] = useState<SignalEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<SignalsResponse>('signals?limit=5')
      .then((r) => setItems(r.items ?? []))
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  return (
    <section className="rounded-lg border border-border p-4" style={{ background: 'var(--surface-elev)' }}>
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="h-section">Recent Signals</h3>
        <button
          type="button"
          onClick={() => navigate('/signals')}
          className="font-mono text-[10px] hover:underline"
          style={{ color: 'var(--text-dim)' }}
        >
          all signals →
        </button>
      </header>
      {err && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>unavailable</p>}
      {!err && items && items.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>no signals recorded</p>
      )}
      {!err && items && items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((s, i) => {
            const tickColor = s.severity ? SEVERITY_TICK_COLOR[s.severity] : 'transparent';
            const verdictColor = VERDICT_COLOR[s.signal] ?? 'var(--ink-2)';
            const verdictLabel = LABELS[s.signal] ?? s.signal;
            return (
              <li key={`${s.timestamp}-${i}`} className="flex items-center gap-2 text-xs">
                {/* severity tick — semantic color, no severity = transparent gap */}
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 3,
                    alignSelf: 'stretch',
                    background: tickColor,
                    borderRadius: 1,
                  }}
                  title={s.severity ?? ''}
                />
                <span className="w-14 shrink-0 tabular-nums" style={{ color: 'var(--text-dim)' }}>{timeAgo(s.timestamp)}</span>
                <span className="h-section w-20 shrink-0" style={{ color: verdictColor, fontSize: 11 }}>
                  {verdictLabel}
                </span>
                <span className="w-24 shrink-0 truncate font-mono" style={{ color: 'var(--text-dim)' }}>{s.agentId}</span>
                <span
                  className="flex-1 truncate"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.45, color: 'var(--text)' }}
                >
                  {truncate(s.evidence ?? '', 80)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
