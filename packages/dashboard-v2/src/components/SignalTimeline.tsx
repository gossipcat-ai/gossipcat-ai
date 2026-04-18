import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { EmptyState } from './EmptyState';
import { FindingDetailDrawer } from './FindingDetailDrawer';
import type { SignalEntry } from '@/lib/types';

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<{ consensusId: string; findingId: string } | null>(null);

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
      <div className="rounded-md border border-border/40 bg-card/80 px-4 py-3">
        <EmptyState
          title="No signal history yet"
          hint="Signals are recorded during consensus rounds."
          compact
        />
      </div>
    );
  }

  // Reverse so oldest is left, newest is right
  const ordered = [...signals].reverse();

  // Summary counts row — computed from the fetched window only (not the full
  // `total` population). The API hard-caps at limit=100, so with a 500-signal
  // agent the window is only the most recent slice. Label explicitly says
  // "Last N" so users don't divide counts by total and get a wrong ratio.
  const counts = {
    confirmed: 0,
    disputed: 0,
    unique: 0,
    unverified: 0,
  };
  for (const s of signals) {
    if (s.signal === 'agreement' || s.signal === 'consensus_verified') counts.confirmed++;
    // The "disputed" bucket covers both disagreement AND hallucination_caught
    // — both render as the same red `bg-disputed` color. Legend label below
    // matches "Disputed" so the counts row and legend tell one story.
    else if (s.signal === 'disagreement' || s.signal === 'hallucination_caught') counts.disputed++;
    else if (s.signal === 'unique_confirmed' || s.signal === 'unique_unconfirmed' || s.signal === 'new_finding') counts.unique++;
    else if (s.signal === 'unverified') counts.unverified++;
  }

  const windowSize = signals.length;
  const isWindowed = total > windowSize;

  return (
    <div className="rounded-md border border-border/40 bg-card/80 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Signal Timeline
          </span>
          <span className="font-mono text-[9px] text-muted-foreground/50">
            {isWindowed ? `last ${windowSize} of ${total}` : `${total} total`}
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px]">
          <span className="text-confirmed">{counts.confirmed} confirmed</span>
          {counts.disputed > 0 && <span className="text-disputed">{counts.disputed} disputed</span>}
          {counts.unique > 0 && <span className="text-unique">{counts.unique} unique</span>}
          {counts.unverified > 0 && <span className="text-unverified">{counts.unverified} unverified</span>}
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        {ordered.map((s, i) => {
          const clickable = !!(s.consensusId && s.findingId);
          return (
            <button
              key={i}
              type="button"
              disabled={!clickable}
              onClick={() => {
                if (s.consensusId && s.findingId) {
                  setSelected({ consensusId: s.consensusId, findingId: s.findingId });
                  setDrawerOpen(true);
                }
              }}
              className={`h-4 min-w-[4px] max-w-[12px] flex-1 rounded-sm transition-opacity hover:opacity-80 ${
                SIGNAL_COLORS[s.signal] || 'bg-muted'
              } ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
              title={`${SIGNAL_LABELS[s.signal] || s.signal} — ${timeAgo(s.timestamp)}${clickable ? ' (click for detail)' : ''}`}
            />
          );
        })}
      </div>
      {/* Legend — "Disputed" covers disagreement + hallucination_caught; the
          counts row above uses the same name so a red bar has exactly one
          label throughout the component. */}
      <div className="mt-2 flex flex-wrap gap-3">
        {[
          { color: 'bg-confirmed', label: 'Confirmed' },
          { color: 'bg-disputed', label: 'Disputed' },
          { color: 'bg-unique', label: 'Unique (confirmed)' },
          { color: 'bg-unique/50', label: 'Unique (unconfirmed)' },
          { color: 'bg-unverified', label: 'Unverified' },
        ].map((l) => (
          <div key={l.label} className="flex items-center gap-1">
            <div className={`h-2 w-2 rounded-sm ${l.color}`} />
            <span className="font-mono text-[9px] text-muted-foreground/60">{l.label}</span>
          </div>
        ))}
      </div>
      <FindingDetailDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        consensusId={selected?.consensusId ?? null}
        findingId={selected?.findingId ?? null}
      />
    </div>
  );
}
