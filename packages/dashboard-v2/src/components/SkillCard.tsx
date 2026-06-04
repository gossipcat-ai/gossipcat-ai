import type React from 'react';
import { timeAgo } from '@/lib/utils';
import type { SkillSlot, SkillStatus } from '@/lib/types';
import { shouldShowProgressBar } from '@/lib/skill-card-logic';

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
  pending: 'border-border/50',
  passed: 'border-confirmed/40 bg-confirmed/10 text-confirmed',
  failed: 'border-disputed/40 bg-disputed/10 text-disputed',
  silent_skill: 'border-unverified/40 bg-unverified/10 text-unverified',
  insufficient_evidence: 'border-unverified/40 bg-unverified/10 text-unverified',
  // Match SkillGraduationGrid: inconclusive → --warn (DESIGN.md amber).
  // Raw orange-400 was a different hue, theme-baked, inconsistent with the
  // overview grid showing the same skill data.
  inconclusive: 'border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10 text-[color:var(--warn)]',
  flagged_for_manual_review: 'border-disputed/40 bg-disputed/10 text-disputed',
};

function formatEffectiveness(value: number): { text: string; cls: string; clsStyle?: React.CSSProperties } {
  // value is in [-1, 1] as a delta (pre/post hallucination rate).
  const pp = Math.round(value * 100);
  const sign = pp > 0 ? '+' : '';
  if (pp > 0) return { text: `${sign}${pp}pp`, cls: 'text-confirmed' };
  if (pp < 0) return { text: `${sign}${pp}pp`, cls: 'text-disputed' };
  return { text: `${sign}${pp}pp`, cls: '', clsStyle: { color: 'var(--text-dim)' } };
}

export function SkillCard({ slot }: Props) {
  const status = slot.status;
  const statusCls = status ? STATUS_CLS[status] : 'border-border/50';
  const statusStyle: React.CSSProperties | undefined = (!status || status === 'pending')
    ? { background: 'color-mix(in oklch, var(--surface-sunk) 30%, transparent)', color: 'var(--text-dim)' }
    : undefined;
  const showStrikes = status === 'inconclusive' && (slot.inconclusiveStrikes ?? 0) > 0;
  const forced = slot.forcedDevelops ?? [];
  const latestForced = forced.length > 0 ? forced[forced.length - 1] : null;
  const effectiveness = typeof slot.effectiveness === 'number' ? formatEffectiveness(slot.effectiveness) : null;

  const showProgressBar = shouldShowProgressBar(status, slot.postBindSignals, slot.minEvidence);

  return (
    <div
      className={`rounded-md border p-3 ${slot.enabled ? 'border-border/50' : 'border-border/30 opacity-60'}`}
      style={{ background: 'color-mix(in oklch, var(--surface-elev) 80%, transparent)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`font-mono text-xs font-semibold ${slot.enabled ? '' : 'line-through'}`}
              style={{ color: slot.enabled ? 'var(--text)' : 'var(--text-dim)' }}
            >
              {slot.mode === 'contextual' && '\u26A1 '}
              {slot.name}
            </span>
            <span className="rounded-sm px-1.5 py-0.5 font-mono text-[9px]" style={{ background: 'var(--surface-sunk)', color: 'var(--text-dim)' }}>
              {slot.source}
            </span>
            {slot.mode === 'contextual' && (
              <span className="warn-badge rounded-sm px-1.5 py-0.5 font-mono text-[9px]">
                contextual
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>
            bound {timeAgo(slot.boundAt)}
          </div>
          {showProgressBar && (() => {
            const n = slot.postBindSignals!;
            const total = slot.minEvidence!;
            const pct = Math.round((n / total) * 100);
            const fillPct = Math.min(n / total, 1.0) * 100;
            return (
              <div
                className="mt-1.5"
                title={`MIN_EVIDENCE gate: ${n} of ${total} post-bind signals (${pct}%)`}
              >
                <div className="mb-0.5 font-mono text-[9px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
                  post-bind: {n} / {total}
                </div>
                <div className="relative h-1 w-full overflow-hidden rounded-full border border-border/40" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 30%, transparent)' }}>
                  <div
                    className="absolute inset-y-0 left-0 rounded-full border-r border-confirmed/40 bg-confirmed/20"
                    style={{ width: `${fillPct}%` }}
                  />
                </div>
              </div>
            );
          })()}
        </div>
        {status && (
          <span className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase ${statusCls}`} style={statusStyle} title={STATUS_TOOLTIP[status]}>
            {status.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center gap-3 font-mono text-[10px]">
        {effectiveness && (
          <span className={effectiveness.cls} style={effectiveness.clsStyle} title="Effectiveness: change in hallucination rate pre/post">
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
          className="mt-2 border-t border-border/40 pt-2 font-mono text-[10px]"
          style={{ color: 'var(--text-dim)' }}
          title={latestForced?.reason ? `latest: ${latestForced.reason}` : undefined}
        >
          forced {forced.length} time{forced.length === 1 ? '' : 's'}
          {latestForced && ` · last ${timeAgo(latestForced.timestamp)}`}
        </div>
      )}
    </div>
  );
}
