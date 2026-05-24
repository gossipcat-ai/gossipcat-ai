import { useMemo } from 'react';
import type { AgentData, SkillStatus, SkillSlot } from '@/lib/types';
import { agentColor, timeAgo } from '@/lib/utils';

/**
 * DESIGN.md Step 9 — Skill graduation grid.
 *
 * Renders every live skill across the fleet with a defined verdict color.
 * Detailed companion to `SkillVerdictsSnapshot` (which is just the bar-chart
 * summary). Source: `agents[].skillSlots[]` — already fetched by
 * `OverviewPage`, so no extra request.
 *
 * Verdict palette mirrors `SkillVerdictsSnapshot` (single source of truth).
 *
 * Drift note from spec: spec says "reading the existing skill state JSON" via
 * the `SkillsGetResponse` endpoint. That payload only carries the bind index
 * (agent → skill → { enabled, source, mode, version, boundAt }) — there is no
 * per-skill `status` field on `SkillsGetResponse`. The verdict lives on
 * `AgentData.skillSlots[].status`, sourced from skill frontmatter inside
 * `api-agents.ts`. We use `agents` to satisfy the gate without backend
 * changes. If a future spec requires this grid to render before agents load,
 * `SkillsGetResponse` should be extended to inline per-slot status.
 */

// Subset of SkillStatus that the spec calls out — the 6 graduation verdicts.
type GraduationVerdict =
  | 'passed'
  | 'pending'
  | 'insufficient_evidence'
  | 'inconclusive'
  | 'silent_skill'
  | 'failed';

/**
 * Gate: every live skill renders with a defined color. `Record<...>` keyed by
 * literal status string means a missing key fails at TS compile, not at
 * render with `undefined` fallthrough.
 */
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

// Display order: success → in-flight → degraded → failed. Operator scans
// top-to-bottom looking for problems, so failed lives at the bottom.
const VERDICT_ORDER: GraduationVerdict[] = [
  'passed',
  'pending',
  'inconclusive',
  'insufficient_evidence',
  'silent_skill',
  'failed',
];

// Fallback colors for unexpected status strings or missing status. Render
// defensively — don't crash, don't blank.
const UNKNOWN_COLOR = 'var(--ink-4)';
const UNKNOWN_LABEL = 'unknown';

function isGraduationVerdict(s: string | undefined): s is GraduationVerdict {
  return s !== undefined && s in VERDICT_COLOR;
}

interface Row {
  agentId: string;
  slot: SkillSlot;
  verdict: GraduationVerdict | null; // null = unknown / missing status
}

interface Props {
  agents: AgentData[] | null;
  loading?: boolean;
  error?: string | null;
}

export function SkillGraduationGrid({ agents, loading, error }: Props) {
  const groups = useMemo(() => groupByVerdict(agents), [agents]);

  return (
    <section
      className="rounded-lg border border-border p-4"
      style={{ background: 'var(--surface-elev)' }}
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="h-section">Skill Graduation</h3>
        <div className="flex items-center gap-2">
          {error && (
            <span
              className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]"
              style={{
                color: 'var(--bad)',
                background: 'color-mix(in oklch, var(--bad) 12%, transparent)',
                border: '1px solid color-mix(in oklch, var(--bad) 30%, transparent)',
              }}
              title={error}
            >
              error
            </span>
          )}
          <span
            className="font-mono text-[10px]"
            style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}
          >
            {groups.total} live
          </span>
        </div>
      </header>

      {loading && <GridSkeleton />}
      {!loading && groups.total === 0 && !error && (
        <p
          className="text-[12px]"
          style={{ color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)' }}
        >
          No skills graduated yet — agents need more dispatches.
        </p>
      )}
      {!loading && groups.total > 0 && (
        <div className="space-y-4">
          {VERDICT_ORDER.map((v) => {
            const rows = groups.byVerdict.get(v);
            if (!rows || rows.length === 0) return null;
            return (
              <VerdictGroup key={v} verdict={v} rows={rows} />
            );
          })}
          {groups.unknown.length > 0 && (
            <UnknownGroup rows={groups.unknown} />
          )}
        </div>
      )}
    </section>
  );
}

/* ── grouping ───────────────────────────────────────────────────────── */

function groupByVerdict(agents: AgentData[] | null): {
  byVerdict: Map<GraduationVerdict, Row[]>;
  unknown: Row[];
  total: number;
} {
  const byVerdict = new Map<GraduationVerdict, Row[]>();
  const unknown: Row[] = [];
  let total = 0;
  if (!agents) return { byVerdict, unknown, total };

  for (const agent of agents) {
    for (const slot of agent.skillSlots) {
      if (!slot.enabled) continue;
      total++;
      const s = slot.status as SkillStatus | undefined;
      // flagged_for_manual_review (7th status from SkillStatus union) and any
      // unknown string both fall through to the defensive "unknown" bucket so
      // they get a defined color (UNKNOWN_COLOR) instead of blank chrome.
      if (isGraduationVerdict(s)) {
        const arr = byVerdict.get(s) ?? [];
        arr.push({ agentId: agent.id, slot, verdict: s });
        byVerdict.set(s, arr);
      } else {
        unknown.push({ agentId: agent.id, slot, verdict: null });
      }
    }
  }

  // Within each verdict, sort by most-recently-bound first so freshly-changed
  // verdicts surface at the top of the column.
  const sortFn = (a: Row, b: Row) =>
    (b.slot.boundAt ?? '').localeCompare(a.slot.boundAt ?? '');
  for (const arr of byVerdict.values()) arr.sort(sortFn);
  unknown.sort(sortFn);

  return { byVerdict, unknown, total };
}

/* ── verdict group header + grid ────────────────────────────────────── */

function VerdictGroup({ verdict, rows }: { verdict: GraduationVerdict; rows: Row[] }) {
  const color = VERDICT_COLOR[verdict];
  const label = VERDICT_LABEL[verdict];
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: color }}
        />
        <span
          className="h-section"
          style={{ color: 'var(--text-dim)' }}
        >
          {label}
        </span>
        <span
          className="font-mono text-[10px] tabular-nums"
          style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}
        >
          {rows.length}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <SkillCell key={`${r.agentId}::${r.slot.name}`} row={r} color={color} label={label} />
        ))}
      </ul>
    </div>
  );
}

function UnknownGroup({ rows }: { rows: Row[] }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: UNKNOWN_COLOR }}
        />
        <span className="h-section" style={{ color: 'var(--text-dim)' }}>
          {UNKNOWN_LABEL}
        </span>
        <span
          className="font-mono text-[10px] tabular-nums"
          style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}
        >
          {rows.length}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <SkillCell
            key={`${r.agentId}::${r.slot.name}`}
            row={r}
            color={UNKNOWN_COLOR}
            label={r.slot.status ?? UNKNOWN_LABEL}
          />
        ))}
      </ul>
    </div>
  );
}

/* ── individual cell ────────────────────────────────────────────────── */

function SkillCell({ row, color, label }: { row: Row; color: string; label: string }) {
  const { agentId, slot } = row;
  const metric = formatMetric(slot);

  return (
    <li
      className="flex items-center gap-2 rounded-sm border border-border px-2.5 py-1.5"
      style={{ background: 'var(--surface)' }}
      title={`${agentId} · ${slot.name} · ${label}`}
    >
      {/* Per-agent identity dot — only place identity color lives (DESIGN.md). */}
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: agentColor(agentId) }}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px]" style={{ color: 'var(--ink)' }}>
          {slot.name}
        </div>
        <div
          className="truncate text-[10px]"
          style={{
            color: 'color-mix(in oklch, var(--text-dim) 80%, transparent)',
            fontVariant: 'small-caps',
            letterSpacing: '0.04em',
          }}
        >
          {agentId}
        </div>
      </div>
      {metric && (
        <span
          className="shrink-0 font-mono text-[10px] tabular-nums"
          style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}
          title={metric.title}
        >
          {metric.text}
        </span>
      )}
      <span
        className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px]"
        style={{
          color,
          background: `color-mix(in oklch, ${color} 14%, transparent)`,
          border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
          fontVariant: 'small-caps',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </span>
    </li>
  );
}

function formatMetric(slot: SkillSlot): { text: string; title: string } | null {
  // Prefer evidence-progress when MIN_EVIDENCE gate info is present.
  if (typeof slot.postBindSignals === 'number' && typeof slot.minEvidence === 'number') {
    return {
      text: `${slot.postBindSignals}/${slot.minEvidence}`,
      title: `post-bind signals / MIN_EVIDENCE gate`,
    };
  }
  if (typeof slot.effectiveness === 'number') {
    return {
      text: `${Math.round(slot.effectiveness * 100)}%`,
      title: 'effectiveness',
    };
  }
  if (slot.boundAt) {
    return { text: timeAgo(slot.boundAt), title: `bound ${slot.boundAt}` };
  }
  return null;
}

/* ── loading skeleton ───────────────────────────────────────────────── */

function GridSkeleton() {
  // Two pseudo-groups, three cells each.
  return (
    <div className="space-y-4" aria-hidden>
      {[0, 1].map((g) => (
        <div key={g}>
          <div className="mb-2 flex items-center gap-2">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: 'color-mix(in oklch, var(--text-dim) 30%, transparent)' }}
            />
            <span
              className="h-3 w-20 rounded-sm"
              style={{ background: 'color-mix(in oklch, var(--text-dim) 18%, transparent)' }}
            />
          </div>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((c) => (
              <li
                key={c}
                className="h-10 rounded-sm border border-border"
                style={{ background: 'var(--surface)' }}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
