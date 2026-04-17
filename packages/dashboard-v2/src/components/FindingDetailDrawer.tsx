import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import { CitationSnippet } from './CitationSnippet';
import type { FindingDetail } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consensusId: string | null;
  findingId: string | null;
}

// Matches FindingsMetrics SEVERITY_CLS — global severity palette.
const SEVERITY_COLORS: Record<string, string> = {
  critical: 'text-red-400 bg-red-500/10',
  high: 'text-orange-400 bg-orange-500/10',
  medium: 'text-yellow-400 bg-yellow-500/10',
  low: 'text-muted-foreground bg-muted/50',
};

const TAG_COLORS: Record<string, string> = {
  confirmed: 'bg-confirmed',
  disputed: 'bg-disputed',
  unverified: 'bg-unverified',
  unique: 'bg-unique',
  insight: 'bg-muted',
  newFinding: 'bg-unique',
};

export function FindingDetailDrawer({ open, onOpenChange, consensusId, findingId }: Props) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !consensusId || !findingId) { setDetail(null); setError(null); return; }
    setDetail(null);
    setError(null);
    api<FindingDetail>(`finding/${encodeURIComponent(consensusId)}/${encodeURIComponent(findingId)}`)
      .then(setDetail)
      .catch((e) => setError(e.message || 'failed to load finding'));
  }, [open, consensusId, findingId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px] sm:w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">Finding detail</SheetTitle>
        </SheetHeader>

        {error && <div className="mt-4 text-[11px] text-disputed">{error}</div>}
        {!error && !detail && <div className="mt-4 text-[11px] text-muted-foreground">Loading…</div>}

        {detail && (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded ${TAG_COLORS[detail.finding.tag] || 'bg-muted'}`}>
                {detail.finding.tag}
              </span>
              {detail.finding.severity && (
                <span className={`font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded ${SEVERITY_COLORS[detail.finding.severity] || 'bg-muted'}`}>
                  {detail.finding.severity}
                </span>
              )}
              <span className="font-mono text-[9px] text-muted-foreground">
                by {detail.finding.originalAgentId}
              </span>
              {detail.retracted && (
                <span className="font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded bg-disputed/50">
                  retracted
                </span>
              )}
            </div>

            <div className="text-[12px] leading-relaxed whitespace-pre-wrap">
              {detail.finding.finding.replace(/<cite tag="file">[^<]+<\/cite>/g, '').trim()}
            </div>

            {detail.citations.length > 0 && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Citations
                </div>
                {detail.citations.map((c, i) => <CitationSnippet key={i} citation={c} />)}
              </div>
            )}

            <div className="space-y-1">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Coverage
              </div>
              {detail.finding.confirmedBy.length > 0 && (
                <div className="text-[11px]">
                  <span className="text-confirmed">✓</span> confirmed by {detail.finding.confirmedBy.join(', ')}
                </div>
              )}
              {detail.finding.disputedBy.map((d, i) => (
                <div key={i} className="text-[11px]">
                  <span className="text-disputed">✗</span> disputed by {d.agentId}: <span className="text-muted-foreground">{d.reason}</span>
                </div>
              ))}
              {detail.finding.confirmedBy.length === 0 && detail.finding.disputedBy.length === 0 && (
                <div className="text-[11px] text-muted-foreground">No peer review</div>
              )}
            </div>

            {detail.signals.length > 0 && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Signals ({detail.signals.length})
                </div>
                <div className="space-y-1">
                  {detail.signals.map((s, i) => (
                    <div key={i} className="text-[11px] border-l-2 border-border/40 pl-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold">{s.signal}</span>
                        <span className="text-muted-foreground">·</span>
                        <span>{s.agentId}</span>
                        {s.counterpartId && <>
                          <span className="text-muted-foreground">→</span>
                          <span>{s.counterpartId}</span>
                        </>}
                        <span className="text-muted-foreground ml-auto">{timeAgo(s.timestamp)}</span>
                      </div>
                      {s.evidence && <div className="text-muted-foreground mt-0.5">{s.evidence.slice(0, 200)}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-border/40">
              <a href={`#/consensus/${detail.consensusId}`} className="font-mono text-[10px] text-primary hover:underline">
                → consensus round {detail.consensusId}
              </a>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
