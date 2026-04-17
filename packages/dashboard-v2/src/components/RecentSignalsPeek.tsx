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
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recent Signals</h3>
        <button
          type="button"
          onClick={() => navigate('/signals')}
          className="text-xs text-primary hover:underline"
        >
          all signals →
        </button>
      </header>
      {err && <p className="text-xs text-muted-foreground">unavailable</p>}
      {!err && items && items.length === 0 && (
        <p className="text-xs text-muted-foreground">no signals recorded</p>
      )}
      {!err && items && items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((s, i) => (
            <li key={`${s.timestamp}-${i}`} className="flex items-center gap-2 text-xs">
              <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{timeAgo(s.timestamp)}</span>
              <span className="w-20 shrink-0 font-mono uppercase tracking-wide text-foreground">
                {LABELS[s.signal] ?? s.signal}
              </span>
              <span className="w-24 shrink-0 truncate font-mono text-muted-foreground">{s.agentId}</span>
              <span className="flex-1 truncate text-muted-foreground">{truncate(s.evidence ?? '', 80)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
