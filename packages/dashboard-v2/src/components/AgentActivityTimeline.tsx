import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { EmptyState } from './EmptyState';
import { FindingDetailDrawer } from './FindingDetailDrawer';
import type { SignalEntry } from '@/lib/types';

interface Props {
  agentId: string;
}

interface SignalsResponse {
  items: SignalEntry[];
  total: number;
}

type FilterKey = 'all' | 'signals' | 'tasks' | 'skills';

const SIGNAL_TAG_CLS: Record<string, string> = {
  agreement: 'text-confirmed bg-confirmed/10',
  consensus_verified: 'text-confirmed bg-confirmed/10',
  unique_confirmed: 'text-unique bg-unique/10',
  unique_unconfirmed: 'text-unique bg-unique/10',
  new_finding: 'text-unique bg-unique/10',
  disagreement: 'text-disputed bg-disputed/10',
  hallucination_caught: 'text-disputed bg-disputed/10',
  unverified: 'text-unverified bg-unverified/10',
};

export function AgentActivityTimeline({ agentId }: Props) {
  const [signals, setSignals] = useState<SignalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [drawer, setDrawer] = useState<{ consensusId: string; findingId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<SignalsResponse>(`signals?agent=${encodeURIComponent(agentId)}&limit=100`)
      .then((data) => { if (!cancelled) { setSignals(data.items || []); setLoading(false); } })
      .catch(() => { if (!cancelled) { setSignals([]); setLoading(false); } });
    return () => { cancelled = true; };
  }, [agentId]);

  // Reverse-chronological: server returns newest-first for SignalTimeline
  // via the same endpoint, but we sort defensively in case of ordering drift.
  const ordered = [...signals].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  const visible = filter === 'all' || filter === 'signals' ? ordered : [];

  const FilterButton = ({ k, label, enabled }: { k: FilterKey; label: string; enabled: boolean }) => (
    <button
      type="button"
      onClick={() => enabled && setFilter(k)}
      disabled={!enabled}
      className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-semibold transition ${
        filter === k ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
      } ${enabled ? '' : 'opacity-40 cursor-not-allowed'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-md border border-border/40 bg-card/80 px-4 py-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Activity
        </span>
        <div className="flex gap-1">
          <FilterButton k="all" label="All" enabled />
          <FilterButton k="signals" label="Signals" enabled />
          <FilterButton k="tasks" label="Tasks (none yet)" enabled={false} />
          <FilterButton k="skills" label="Skills (none yet)" enabled={false} />
        </div>
      </div>

      {loading ? (
        <div className="py-6 text-center text-xs text-muted-foreground">Loading…</div>
      ) : visible.length === 0 ? (
        <EmptyState
          title="No activity yet"
          hint="Signals, task completions, and skill binds will appear here."
          compact
        />
      ) : (
        <div className="space-y-1">
          {visible.map((s, i) => {
            const tagCls = SIGNAL_TAG_CLS[s.signal] || 'text-muted-foreground bg-muted';
            const clickable = !!(s.consensusId && s.findingId);
            const row = (
              <div className="flex items-start gap-2 py-1.5">
                <span className="shrink-0 font-mono text-[9px] text-muted-foreground/60 tabular-nums w-16">
                  {timeAgo(s.timestamp)}
                </span>
                <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold ${tagCls}`}>
                  {s.signal}
                </span>
                <div className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                  {s.counterpartId && (
                    <span className="font-mono text-[10px] text-muted-foreground/70">→ {s.counterpartId} · </span>
                  )}
                  {s.evidence && <span>{s.evidence.length > 160 ? s.evidence.slice(0, 160) + '…' : s.evidence}</span>}
                </div>
              </div>
            );
            if (clickable) {
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setDrawer({ consensusId: s.consensusId!, findingId: s.findingId! })}
                  className="w-full rounded-sm text-left transition hover:bg-accent/40"
                >
                  {row}
                </button>
              );
            }
            return <div key={i}>{row}</div>;
          })}
        </div>
      )}

      <FindingDetailDrawer
        open={!!drawer}
        onOpenChange={(open) => { if (!open) setDrawer(null); }}
        consensusId={drawer?.consensusId ?? null}
        findingId={drawer?.findingId ?? null}
      />
    </div>
  );
}
