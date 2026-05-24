import { useMemo } from 'react';
import type { SkillsApiResponse, SkillEffectivenessEntry, SkillStatus } from '@/lib/types';
import { SkillEffectivenessSparkline } from './SkillEffectivenessSparkline';
import { href } from '@/lib/router';

/**
 * DESIGN.md Step 9.5 — SkillGraduationGrid as a flat card grid.
 *
 * Replaces the verdict-grouped layout (Step 9). Each cell shows a post-bind
 * effectiveness sparkline with a dashed graduation threshold line, plus the
 * skill name on top and the small-caps verdict + signal count on the bottom.
 *
 * Source: GET /dashboard/api/skills `effectiveness` array — derived from
 * agent-performance.jsonl bucketed by skill into 10 equal-time post-bind
 * windows. UNKNOWN-verdict skills go into a native <details> collapsible
 * below the main grid.
 *
 * Verdict palette mirrors SkillVerdictsSnapshot (single source of truth).
 */

// 6 graduation verdicts that get their own sparkline color. The 7th
// (flagged_for_manual_review) plus any unknown string fall through to the
// UNKNOWN collapsible bucket below.
type GraduationVerdict =
  | 'passed'
  | 'pending'
  | 'insufficient_evidence'
  | 'inconclusive'
  | 'silent_skill'
  | 'failed';

const VERDICT_COLOR: Record<GraduationVerdict, string> = {
  passed: 'var(--ok)',
  pending: 'var(--info)',
  insufficient_evidence: 'var(--idle)',
  inconclusive: 'var(--warn)',
  silent_skill: 'var(--ink-3)',
  failed: 'var(--bad)',
};

const VERDICT_LABEL: Record<GraduationVerdict, string> = {
  passed: 'passed',
  pending: 'pending',
  insufficient_evidence: 'insufficient',
  inconclusive: 'inconclusive',
  silent_skill: 'silent',
  failed: 'failed',
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

  const skillCount = total;

  return (
    <section className="space-y-2">
      {/* Section header row — outside the card per the mockup. */}
      <header className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h3 className="h-section">Skill Graduation</h3>
          <span
            className="font-mono text-[11px] tabular-nums"
            style={{ color: 'var(--accent)' }}
          >
            {skillCount}
          </span>
          <span
            className="font-mono text-[11px]"
            style={{ color: 'var(--ink-3)' }}
          >
            skills · {transitions} transitions /24h
          </span>
        </div>
        <a
          href={href('/')}
          className="font-mono text-[11px] transition hover:underline"
          style={{ color: 'var(--ink-3)' }}
        >
          skill detail →
        </a>
      </header>

      <div
        className="rounded-lg border border-border p-4"
        style={{ background: 'var(--surface-elev)' }}
      >
        <p className="mb-3 text-[11px]" style={{ color: 'var(--ink-3)' }}>
          Each cell shows the post-bind effectiveness curve. Dashed line = graduation threshold.
          Verdict is from the latest evidence window.
        </p>

        {error && <ErrorBanner message={error} />}
        {loading && !skills && <GridSkeleton />}
        {!loading && total === 0 && !error && (
          <p className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
            No skills bound yet — agents need at least one dispatch with a skill match.
          </p>
        )}
        {total > 0 && (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
            {known.map((entry) => (
              <SkillCard key={cellKey(entry)} entry={entry} />
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
                style={{ fontVariant: 'small-caps', letterSpacing: '0.04em' }}
              >
                {unknown.length} unknown
              </span>
            </summary>
            <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
              {unknown.map((entry) => (
                <SkillCard key={cellKey(entry)} entry={entry} />
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
  // Transitions /24h proxy: skills whose curve has BOTH a passing and a failing
  // window inside the last 24h slice. Approximated by checking the last two
  // bucket values straddle the threshold (one above, one below). The backend
  // doesn't expose drift_strike_at / regressed_from_passed_at directly yet, so
  // this is a curve-shape heuristic, not a state-machine read. Documented drift
  // from spec — easy to upgrade once those fields surface in the API.
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
  // Sort known: failing-first, then by name so operator eyes land on
  // problems immediately within the flat grid.
  const order: Record<GraduationVerdict, number> = {
    failed: 0,
    inconclusive: 1,
    silent_skill: 2,
    insufficient_evidence: 3,
    pending: 4,
    passed: 5,
  };
  known.sort((a, b) => {
    const ra = isGraduationVerdict(a.status) ? order[a.status] : 99;
    const rb = isGraduationVerdict(b.status) ? order[b.status] : 99;
    if (ra !== rb) return ra - rb;
    return a.skill.localeCompare(b.skill);
  });
  unknown.sort((a, b) => a.skill.localeCompare(b.skill));
  return { known, unknown, total: known.length + unknown.length, transitions };
}

/* ── single skill card ─────────────────────────────────────────────────── */

function SkillCard({ entry }: { entry: SkillEffectivenessEntry }) {
  const verdict = isGraduationVerdict(entry.status) ? entry.status : null;
  const color = verdict ? VERDICT_COLOR[verdict] : UNKNOWN_COLOR;
  const label = verdict ? VERDICT_LABEL[verdict] : (entry.status ?? 'unknown');

  return (
    <li
      className="flex flex-col gap-1.5 rounded-sm border border-border p-2.5"
      style={{ background: 'var(--surface)' }}
      title={`${entry.agentId} · ${entry.skill} · ${label} · N=${entry.n}`}
    >
      {/* Top: skill name */}
      <div className="truncate text-[13px]" style={{ color: 'var(--ink)' }}>
        {entry.skill}
      </div>
      {/* Middle: sparkline */}
      <SkillEffectivenessSparkline
        curve={entry.curve}
        threshold={entry.threshold}
        stroke={color}
      />
      {/* Bottom: verdict label + N */}
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="truncate text-[10px]"
          style={{
            color,
            fontVariant: 'small-caps',
            letterSpacing: '0.04em',
          }}
        >
          {label}
        </span>
        <span
          className="font-mono text-[10px] tabular-nums"
          style={{ color: 'var(--ink-3)' }}
        >
          N={entry.n}
        </span>
      </div>
    </li>
  );
}

/* ── states ────────────────────────────────────────────────────────────── */

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="mb-3 rounded-sm px-2 py-1 font-mono text-[10px]"
      style={{
        color: 'var(--bad)',
        background: 'color-mix(in oklch, var(--bad) 12%, transparent)',
        border: '1px solid color-mix(in oklch, var(--bad) 30%, transparent)',
      }}
    >
      error · {message}
    </div>
  );
}

function GridSkeleton() {
  return (
    <ul
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
      aria-hidden
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex h-[88px] flex-col gap-1.5 rounded-sm border border-border p-2.5"
          style={{ background: 'var(--surface)' }}
        >
          <span
            className="h-3 w-3/4 rounded-sm"
            style={{ background: 'color-mix(in oklch, var(--text-dim) 18%, transparent)' }}
          />
          <span
            className="h-[30px] w-full rounded-sm"
            style={{ background: 'color-mix(in oklch, var(--text-dim) 10%, transparent)' }}
          />
          <span
            className="h-3 w-1/2 rounded-sm"
            style={{ background: 'color-mix(in oklch, var(--text-dim) 14%, transparent)' }}
          />
        </li>
      ))}
    </ul>
  );
}
