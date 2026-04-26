import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { EmptyState } from './EmptyState';
import { FindingDetailDrawer } from './FindingDetailDrawer';
import { useElementWidth } from '@/hooks/useElementWidth';
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
  // Amber/orange — fabricated citations are write-time warnings, not consensus
  // errors; keep visually distinct from the red disputed bucket.
  citation_fabricated: 'bg-amber-500',
};

const SIGNAL_LABELS: Record<string, string> = {
  agreement: 'Confirmed',
  consensus_verified: 'Confirmed',
  unique_confirmed: 'Unique (confirmed)',
  unique_unconfirmed: 'Unique (unconfirmed)',
  disagreement: 'Disputed',
  hallucination_caught: 'Hallucination',
  new_finding: 'New finding',
  unverified: 'Unverified',
  citation_fabricated: 'Fabricated citation',
};

// Pill sizing budget. MIN_PILL_WIDTH gives a slight breathing margin above the
// CSS `min-w-[4px]` clamp plus the 2px (gap-0.5) separator. MAX_CAP bounds the
// API request on ultra-wide monitors so we don't ask for unbounded history.
const MIN_PILL_WIDTH = 6;
const MAX_CAP = 500;
const DEFAULT_LIMIT = 100;
const DEBOUNCE_MS = 150;

function computeCap(width: number): number {
  if (width <= 0) return DEFAULT_LIMIT;
  const raw = Math.floor(width / MIN_PILL_WIDTH);
  return Math.max(1, Math.min(raw, MAX_CAP));
}

export function SignalTimeline({ agentId }: { agentId: string }) {
  const [signals, setSignals] = useState<SignalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<{ consensusId: string; findingId: string } | null>(null);
  const [containerRef, containerWidth] = useElementWidth<HTMLDivElement>();
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced update of `limit` from measured width. Rapid resizes shouldn't
  // spam the API; settle for DEBOUNCE_MS then apply.
  useEffect(() => {
    if (containerWidth <= 0) return;
    const next = computeCap(containerWidth);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLimit((prev) => (prev === next ? prev : next));
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [containerWidth]);

  useEffect(() => {
    api<SignalsResponse>(`signals?agent=${encodeURIComponent(agentId)}&limit=${limit}`)
      .then((data) => {
        setSignals(data.items || []);
        setTotal(data.total || 0);
      })
      .catch(() => {});
  }, [agentId, limit]);

  // Reverse so oldest is left, newest is right
  const ordered = useMemo(() => [...signals].reverse(), [signals]);

  // Summary counts row — computed from the fetched window only (not the full
  // `total` population). With a capped window the counts still reflect only
  // the most recent slice. Label explicitly says "Last N" so users don't
  // divide counts by total and get a wrong ratio.
  const counts = { confirmed: 0, disputed: 0, unique: 0, unverified: 0, fabricated: 0 };
  for (const s of signals) {
    if (s.signal === 'agreement' || s.signal === 'consensus_verified') counts.confirmed++;
    // The "disputed" bucket covers both disagreement AND hallucination_caught
    // — both render as the same red `bg-disputed` color. Legend label below
    // matches "Disputed" so the counts row and legend tell one story.
    else if (s.signal === 'disagreement' || s.signal === 'hallucination_caught') counts.disputed++;
    else if (s.signal === 'unique_confirmed' || s.signal === 'unique_unconfirmed' || s.signal === 'new_finding') counts.unique++;
    else if (s.signal === 'unverified') counts.unverified++;
    // Separate bucket from consensus-UNVERIFIED: fabricated citations are
    // write-time annotator rejections, not consensus cross-review outcomes.
    else if (s.signal === 'citation_fabricated') counts.fabricated++;
  }

  const windowSize = signals.length;
  const isWindowed = total > windowSize;

  if (signals.length === 0) {
    return (
      <div ref={containerRef} className="rounded-md border border-border/40 bg-card/80 px-4 py-3">
        <EmptyState
          title="No signal history yet"
          hint="Signals are recorded during consensus rounds."
          compact
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="rounded-md border border-border/40 bg-card/80 px-4 py-3">
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
          {counts.fabricated > 0 && <span className="text-amber-500">{counts.fabricated} fabricated</span>}
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
              // No max-width cap: pills stretch to fill the row regardless of
              // viewport so the timeline never has trailing whitespace when
              // signals.length < the visual width budget. See agent-page UX
              // memo (project_agent_page_timeline_ux.md).
              className={`h-4 min-w-[4px] flex-1 rounded-sm transition-opacity hover:opacity-80 ${
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
          { color: 'bg-amber-500', label: 'Fabricated citation' },
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
