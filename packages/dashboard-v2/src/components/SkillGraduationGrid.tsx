import { useMemo } from 'react';
import type { SkillsApiResponse, SkillEffectivenessEntry, SkillStatus } from '@gossip/types';
import { SkillEffectivenessSparkline } from './SkillEffectivenessSparkline';
import { ErrorChip } from './ErrorChip';
import { href } from '@/lib/router';
import { agentColor } from '@/lib/utils';

/**
 * DESIGN.md Step 9 — SkillGraduationGrid (redesigned for issue #571).
 *
 * Each card SEPARATES the frozen verdict (with the stored basis it was made on)
 * from the live 7d activity window. This resolves the "FAILED 1.00/0.70 N=27"
 * confation where three numbers from three eras were shown unlabeled.
 *
 * Card anatomy:
 *   TOP HALF  — verdict section: chip (semantic color), stored basis (storedEffectiveness
 *               delta + threshold), "as of" date (verdictAt).
 *   BOTTOM HALF — live 7d section: sparkline + N, labeled "live 7d".
 *
 * liveRecovered badge: when status is failed/silent_skill but 7d trailing rate
 * >= threshold, show "recovered · re-test pending" in --ok-soft.
 *
 * Sort order: failed/flagged → inconclusive → insufficient → passed → pending → silent.
 * Unknown-verdict skills collapse into "▶ N unknown" <details>.
 *
 * Verdict → DESIGN.md semantic token (NEVER --accent for status):
 *   passed               → --ok
 *   pending              → --info
 *   insufficient_evidence → --idle
 *   inconclusive/flagged → --warn
 *   silent_skill         → --ink-3
 *   failed               → --bad
 */

type GraduationVerdict =
  | 'passed'
  | 'pending'
  | 'insufficient_evidence'
  | 'inconclusive'
  | 'silent_skill'
  | 'failed'
  | 'flagged_for_manual_review';

const VERDICT_COLOR: Record<GraduationVerdict, string> = {
  passed: 'var(--ok)',
  pending: 'var(--info)',
  insufficient_evidence: 'var(--idle)',
  inconclusive: 'var(--warn)',
  silent_skill: 'var(--ink-3)',
  failed: 'var(--bad)',
  flagged_for_manual_review: 'var(--warn)',
};

const VERDICT_LABEL: Record<GraduationVerdict, string> = {
  passed: 'passed',
  pending: 'pending',
  insufficient_evidence: 'insufficient',
  inconclusive: 'inconclusive',
  silent_skill: 'silent',
  failed: 'failed',
  flagged_for_manual_review: 'flagged',
};

// Sort priority: action-needed first, then informational, then all-clear.
const VERDICT_ORDER: Record<GraduationVerdict, number> = {
  failed: 0,
  flagged_for_manual_review: 1,
  inconclusive: 2,
  insufficient_evidence: 3,
  passed: 4,
  pending: 5,
  silent_skill: 6,
};

const UNKNOWN_COLOR = 'var(--ink-4)';

function isGraduationVerdict(s: SkillStatus | null | undefined): s is GraduationVerdict {
  return s !== undefined && s !== null && s in VERDICT_COLOR;
}

interface Props {
  skills: SkillsApiResponse | null;
  loading?: boolean;
  error?: string | null;
}

export function SkillGraduationGrid({ skills, loading, error }: Props) {
  const { known, unknown, total, transitions } = useMemo(
    () => partition(skills?.effectiveness),
    [skills],
  );

  return (
    <section className="space-y-2">
      {/* Section header — small-caps Geist per DESIGN.md */}
      <header className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h3 className="h-section">skill graduation</h3>
          <span
            className="font-mono text-[11px] tabular-nums font-bold"
            style={{ color: 'var(--ink)', fontFamily: "'JetBrains Mono', monospace" }}
          >
            {total}
          </span>
          <span
            className="text-[11px]"
            style={{ color: 'var(--ink-3)', fontFamily: 'Geist, var(--font-sans)' }}
          >
            skills · {transitions} transitions /24h
          </span>
        </div>
        <a
          href={href('/')}
          className="text-[11px] transition hover:underline"
          style={{ color: 'var(--ink-3)', fontFamily: "'JetBrains Mono', monospace" }}
        >
          skill detail →
        </a>
        {error && <ErrorChip message={error} className="ml-2" />}
      </header>

      <div
        className="rounded-lg border p-4"
        style={{ background: 'var(--surface-elev)', borderColor: 'var(--border)' }}
      >
        {/* Contextual help — distinguishes the two halves */}
        <p className="mb-3 text-[11px]" style={{ color: 'var(--ink-3)', fontFamily: 'Geist, var(--font-sans)' }}>
          Top: frozen verdict + stored basis. Bottom: live 7d activity. Dashed line = graduation threshold.
        </p>

        {/* DESIGN.md error contract: error lives in header ErrorChip; cached
            grid dims to 50% so operator keeps last-known context. */}
        {loading && !skills && <GridSkeleton />}
        {!loading && total === 0 && !error && (
          <p className="text-[12px]" style={{ color: 'var(--ink-3)', fontFamily: 'Geist, var(--font-sans)' }}>
            No skills bound yet — agents need at least one dispatch with a skill match.
          </p>
        )}
        {total > 0 && (
          <ul
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6"
            style={error ? { opacity: 0.5 } : undefined}
          >
            {known.map((entry) => (
              <GraduationCard key={cellKey(entry)} entry={entry} />
            ))}
          </ul>
        )}

        {unknown.length > 0 && (
          <details className="mt-4 group">
            <summary
              className="flex cursor-pointer list-none items-center gap-2 select-none"
              style={{ color: 'var(--ink-3)' }}
            >
              <span
                aria-hidden
                className="chevron inline-block transition-transform"
                style={{ fontSize: '10px', lineHeight: 1 }}
              >
                ▶
              </span>
              <span
                className="text-[11px]"
                style={{
                  fontVariant: 'small-caps',
                  letterSpacing: '0.04em',
                  fontFamily: 'Geist, var(--font-sans)',
                  fontWeight: 600,
                }}
              >
                {unknown.length} unknown
              </span>
            </summary>
            <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
              {unknown.map((entry) => (
                <GraduationCard key={cellKey(entry)} entry={entry} />
              ))}
            </ul>
            <style>{`
              details[open] > summary > .chevron { transform: rotate(90deg); }
            `}</style>
          </details>
        )}
      </div>
    </section>
  );
}

function cellKey(e: SkillEffectivenessEntry): string {
  return `${e.agentId}::${e.skill}`;
}

/* ── partition ─────────────────────────────────────────────────────────── */

function partition(
  list: SkillEffectivenessEntry[] | undefined,
): {
  known: SkillEffectivenessEntry[];
  unknown: SkillEffectivenessEntry[];
  total: number;
  transitions: number;
} {
  if (!list) return { known: [], unknown: [], total: 0, transitions: 0 };
  const known: SkillEffectivenessEntry[] = [];
  const unknown: SkillEffectivenessEntry[] = [];
  // Transitions /24h proxy: last two buckets straddle the threshold.
  let transitions = 0;
  for (const e of list) {
    if (isGraduationVerdict(e.status)) known.push(e);
    else unknown.push(e);
    if (e.curve.length >= 2) {
      const tail = e.curve.slice(-2);
      const above = tail.filter((p) => p.value != null && p.value >= e.threshold).length;
      const below = tail.filter((p) => p.value != null && p.value < e.threshold).length;
      if (above >= 1 && below >= 1) transitions++;
    }
  }
  known.sort((a, b) => {
    const ra = isGraduationVerdict(a.status) ? VERDICT_ORDER[a.status] : 99;
    const rb = isGraduationVerdict(b.status) ? VERDICT_ORDER[b.status] : 99;
    if (ra !== rb) return ra - rb;
    return a.skill.localeCompare(b.skill);
  });
  unknown.sort((a, b) => a.skill.localeCompare(b.skill));
  return { known, unknown, total: known.length + unknown.length, transitions };
}

/* ── GraduationCard ─────────────────────────────────────────────────────── */

function GraduationCard({ entry }: { entry: SkillEffectivenessEntry }) {
  const verdict = isGraduationVerdict(entry.status) ? entry.status : null;
  const verdictColor = verdict ? VERDICT_COLOR[verdict] : UNKNOWN_COLOR;
  const verdictLabel = verdict ? VERDICT_LABEL[verdict] : (entry.status ?? 'unknown');

  // Stored effectiveness delta (what the verdict was based on — not the live rate)
  const storedEff = typeof entry.storedEffectiveness === 'number' ? entry.storedEffectiveness : null;
  const storedEffPp = storedEff !== null ? Math.round(storedEff * 100) : null;

  // "Verdict as of" date
  const verdictDateStr = entry.verdictAt ? formatShortDate(entry.verdictAt) : null;

  // liveRecovered: failed/silent but 7d trailing rate >= threshold
  const showRecoveredBadge = entry.liveRecovered === true;

  return (
    <li
      className="flex flex-col rounded-lg border"
      style={{ background: 'var(--surface-elev)', borderColor: 'var(--border)' }}
      title={`${entry.agentId} · ${entry.skill} · ${verdictLabel} · N=${entry.n}`}
    >
      {/* ── VERDICT SECTION ─────────────────────────────────────────────── */}
      <div
        className="flex flex-col gap-1.5 rounded-t-lg px-2.5 pt-2.5 pb-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {/* Skill name */}
        <div
          className="truncate text-[12px] font-medium leading-tight"
          style={{ color: 'var(--ink)', fontFamily: 'Geist, var(--font-sans)' }}
        >
          {entry.skill}
        </div>

        {/* Agent identity row — bloom dot + agent id in mono */}
        <div className="flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: agentColor(entry.agentId) }}
          />
          <span
            className="truncate text-[10px]"
            style={{ color: 'var(--ink-3)', fontFamily: "'JetBrains Mono', monospace" }}
          >
            {entry.agentId}
          </span>
        </div>

        {/* Verdict chip + recovered badge */}
        <div className="flex flex-wrap items-center gap-1">
          <span
            className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              color: verdictColor,
              background: `color-mix(in oklch, ${verdictColor} 12%, transparent)`,
              border: `1px solid color-mix(in oklch, ${verdictColor} 25%, transparent)`,
              fontVariant: 'small-caps',
              letterSpacing: '0.04em',
              fontFamily: 'Geist, var(--font-sans)',
            }}
          >
            {verdictLabel}
          </span>

          {showRecoveredBadge && (
            <span
              className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px]"
              style={{
                color: 'var(--ok)',
                background: 'var(--ok-soft)',
                border: '1px solid color-mix(in oklch, var(--ok) 25%, transparent)',
                fontFamily: 'Geist, var(--font-sans)',
                letterSpacing: '0.02em',
              }}
              title="Live 7d signals show recovery above threshold — but the stored verdict is frozen. Re-test to graduate."
            >
              recovered · re-test pending
            </span>
          )}
        </div>

        {/* Stored basis row: delta pp vs threshold + "as of" date */}
        {(storedEffPp !== null || verdictDateStr) && (
          <div className="flex items-baseline gap-1.5 flex-wrap">
            {storedEffPp !== null && (
              <span
                className="text-[10px] tabular-nums"
                style={{
                  color: storedEffPp > 0 ? 'var(--ok)' : storedEffPp < 0 ? 'var(--bad)' : 'var(--ink-3)',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
                title={`Stored effectiveness delta: ${storedEffPp > 0 ? '+' : ''}${storedEffPp}pp (basis for this verdict)`}
              >
                {storedEffPp > 0 ? '+' : ''}{storedEffPp}pp
              </span>
            )}
            {storedEffPp !== null && (
              <span
                className="text-[10px]"
                style={{ color: 'var(--ink-3)', fontFamily: 'Geist, var(--font-sans)' }}
              >
                vs {entry.threshold.toFixed(2)}
              </span>
            )}
            {verdictDateStr && (
              <span
                className="text-[10px] tabular-nums"
                style={{ color: 'var(--ink-4)', fontFamily: "'JetBrains Mono', monospace" }}
                title={`Verdict as of: ${entry.verdictAt}`}
              >
                {verdictDateStr}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── LIVE 7D SECTION ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1 px-2.5 pt-1.5 pb-2.5">
        <div className="flex items-center justify-between">
          <span
            className="text-[10px]"
            style={{
              color: 'var(--ink-3)',
              fontVariant: 'small-caps',
              letterSpacing: '0.04em',
              fontFamily: 'Geist, var(--font-sans)',
              fontWeight: 600,
            }}
          >
            live 7d
          </span>
          <span
            className="text-[10px] tabular-nums"
            style={{ color: 'var(--ink-3)', fontFamily: "'JetBrains Mono', monospace" }}
            title="Total post-bind signals in the 7d window"
          >
            N=<span style={{ color: 'var(--ink)' }}>{entry.n}</span>
          </span>
        </div>
        <SkillEffectivenessSparkline
          curve={entry.curve}
          threshold={entry.threshold}
          stroke={verdictColor}
          width={120}
          height={28}
        />
      </div>
    </li>
  );
}

/* ── helpers ────────────────────────────────────────────────────────────── */

/** Format an ISO timestamp as compact "MMM D" (same year) or "MMM D 'YY". */
function formatShortDate(iso: string): string | null {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const month = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    return sameYear ? `${month} ${day}` : `${month} ${day} '${String(d.getFullYear()).slice(-2)}`;
  } catch {
    return null;
  }
}

/* ── states ────────────────────────────────────────────────────────────── */

function GridSkeleton() {
  return (
    <ul
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6"
      aria-hidden
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex flex-col rounded-lg border"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-elev)', minHeight: '120px' }}
        >
          <div
            className="flex flex-col gap-1.5 px-2.5 pt-2.5 pb-2"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span className="h-3 w-3/4 rounded-sm" style={{ background: 'color-mix(in oklch, var(--border) 40%, transparent)' }} />
            <span className="h-2.5 w-1/2 rounded-sm" style={{ background: 'color-mix(in oklch, var(--border) 40%, transparent)' }} />
            <span className="h-5 w-16 rounded-full" style={{ background: 'color-mix(in oklch, var(--border) 40%, transparent)' }} />
          </div>
          <div className="flex flex-col gap-1 px-2.5 pt-1.5 pb-2.5">
            <span className="h-2.5 w-10 rounded-sm" style={{ background: 'color-mix(in oklch, var(--border) 40%, transparent)' }} />
            <span className="h-7 w-full rounded-sm" style={{ background: 'color-mix(in oklch, var(--border) 40%, transparent)' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
