import { timeAgo } from '@/lib/utils';
import type { SkillSlot, SkillStatus } from '@/lib/types';

interface Props {
  slot: SkillSlot;
}

const STATUS_TOOLTIP: Record<SkillStatus, string> = {
  silent_skill: 'No signals recorded after bind — skill may not be injecting correctly',
  insufficient_evidence: 'Fewer than 120 post-bind signals — verdict pending more data',
  inconclusive: 'Mixed signals — needs further evaluation',
  passed: 'Skill verified effective',
  failed: 'Skill verified ineffective',
  pending: 'Awaiting evidence',
  flagged_for_manual_review: 'Manual review required',
};

const STATUS_CLS: Record<SkillStatus, string> = {
  pending: 'border-border/50 bg-muted/30 text-muted-foreground',
  passed: 'border-confirmed/40 bg-confirmed/10 text-confirmed',
  failed: 'border-disputed/40 bg-disputed/10 text-disputed',
  silent_skill: 'border-unverified/40 bg-unverified/10 text-unverified',
  insufficient_evidence: 'border-unverified/40 bg-unverified/10 text-unverified',
  inconclusive: 'border-unique/40 bg-unique/10 text-unique',
  flagged_for_manual_review: 'border-disputed/40 bg-disputed/10 text-disputed',
};

function formatEffectiveness(value: number): { text: string; cls: string } {
  // value is in [-1, 1] as a delta (pre/post hallucination rate).
  const pp = Math.round(value * 100);
  const sign = pp > 0 ? '+' : '';
  const cls = pp > 0 ? 'text-confirmed' : pp < 0 ? 'text-disputed' : 'text-muted-foreground';
  return { text: `${sign}${pp}pp`, cls };
}

export function SkillCard({ slot }: Props) {
  const status = slot.status;
  const statusCls = status ? STATUS_CLS[status] : 'border-border/50 bg-muted/30 text-muted-foreground';
  const showStrikes = status === 'inconclusive' && (slot.inconclusiveStrikes ?? 0) > 0;
  const forced = slot.forcedDevelops ?? [];
  const latestForced = forced.length > 0 ? forced[forced.length - 1] : null;
  const effectiveness = typeof slot.effectiveness === 'number' ? formatEffectiveness(slot.effectiveness) : null;

  return (
    <div
      className={`rounded-md border bg-card/80 p-3 ${slot.enabled ? 'border-border/50' : 'border-border/30 opacity-60'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`font-mono text-xs font-semibold ${slot.enabled ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
              {slot.mode === 'contextual' && '\u26A1 '}
              {slot.name}
            </span>
            <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
              {slot.source}
            </span>
            {slot.mode === 'contextual' && (
              <span className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-400">
                contextual
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground/60">
            bound {timeAgo(slot.boundAt)}
          </div>
        </div>
        {status && (
          <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase ${statusCls}`} title={STATUS_TOOLTIP[status]}>
            {status.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center gap-3 font-mono text-[10px]">
        {effectiveness && (
          <span className={effectiveness.cls} title="Effectiveness: change in hallucination rate pre/post">
            {effectiveness.text}
          </span>
        )}
        {showStrikes && (
          <span className="text-unique" title={slot.inconclusiveAt ? `last strike ${timeAgo(slot.inconclusiveAt)}` : undefined}>
            {slot.inconclusiveStrikes} strike{slot.inconclusiveStrikes === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {forced.length > 0 && (
        <div
          className="mt-2 border-t border-border/40 pt-2 font-mono text-[10px] text-muted-foreground"
          title={latestForced?.reason ? `latest: ${latestForced.reason}` : undefined}
        >
          forced {forced.length} time{forced.length === 1 ? '' : 's'}
          {latestForced && ` · last ${timeAgo(latestForced.timestamp)}`}
        </div>
      )}
    </div>
  );
}
