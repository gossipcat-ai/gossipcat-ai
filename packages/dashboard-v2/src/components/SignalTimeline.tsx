import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';

interface SignalEntry {
  signal: string;
  agentId: string;
  timestamp: string;
  evidence?: string;
}

interface SignalsResponse {
  items: SignalEntry[];
  total: number;
}

const SIGNAL_COLORS: Record<string, string> = {
  agreement: 'bg-confirmed',
  consensus_verified: 'bg-confirmed',
  unique_confirmed: 'bg-unique',
  unique_unconfirmed: 'bg-unique/50',
  disagreement: 'bg-disputed/70',
  hallucination_caught: 'bg-disputed',
  new_finding: 'bg-unique',
  unverified: 'bg-unverified',
};

const SIGNAL_LABELS: Record<string, string> = {
  agreement: 'Confirmed',
  consensus_verified: 'Confirmed',
  unique_confirmed: 'Unique (confirmed)',
  unique_unconfirmed: 'Unique',
  disagreement: 'Disputed',
  hallucination_caught: 'Hallucination',
  new_finding: 'New finding',
  unverified: 'Unverified',
};

export function SignalTimeline({ agentId }: { agentId: string }) {
  const [signals, setSignals] = useState<SignalEntry[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    api<SignalsResponse>(`signals?agent=${encodeURIComponent(agentId)}&limit=100`)
      .then((data) => {
        setSignals(data.items || []);
        setTotal(data.total || 0);
      })
      .catch(() => {});
  }, [agentId]);

  if (signals.length === 0) {
    return (
      <div className="rounded-md border border-border/40 bg-card/80 px-4 py-3 text-center text-xs text-muted-foreground">
        No signal history yet.
      </div>
    );
  }

  // Reverse so oldest is left, newest is right
  const ordered = [...signals].reverse();

  return (
    <div className="rounded-md border border-border/40 bg-card/80 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Signal Timeline
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {total} total
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        {ordered.map((s, i) => (
          <div
            key={i}
            className={`h-4 w-1.5 rounded-sm transition-opacity hover:opacity-80 ${
              SIGNAL_COLORS[s.signal] || 'bg-muted'
            }`}
            title={`${SIGNAL_LABELS[s.signal] || s.signal} — ${timeAgo(s.timestamp)}`}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-3">
        {[
          { color: 'bg-confirmed', label: 'Confirmed' },
          { color: 'bg-disputed', label: 'Hallucination' },
          { color: 'bg-unique', label: 'Unique' },
          { color: 'bg-unverified', label: 'Unverified' },
        ].map((l) => (
          <div key={l.label} className="flex items-center gap-1">
            <div className={`h-2 w-2 rounded-sm ${l.color}`} />
            <span className="font-mono text-[9px] text-muted-foreground/60">{l.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
