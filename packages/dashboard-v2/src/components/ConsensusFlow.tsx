import { useEffect, useMemo, useState } from 'react';
import type {
  ConsensusFlowEdge,
  ConsensusFlowFamily,
  ConsensusFlowResponse,
  ConsensusFlowVerdict,
} from '@/lib/types';

interface ConsensusFlowProps {
  consensusId: string;
  /** Pre-fetched data; if omitted, the component fetches itself. */
  data?: ConsensusFlowResponse;
  onError?: (error: Error) => void;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'full'; data: ConsensusFlowResponse }
  | { kind: 'error'; error: string; stale?: ConsensusFlowResponse };

const VERDICT_COLOR: Record<ConsensusFlowVerdict, string> = {
  confirmed: 'var(--ok)',
  disputed: 'var(--bad)',
  unverified: 'var(--info)',
  unique: 'var(--ink-3)',
};

const VERDICT_LABEL: Record<ConsensusFlowVerdict, string> = {
  confirmed: 'confirmed',
  disputed: 'disputed',
  unverified: 'unverified',
  unique: 'unique',
};

const FAMILY_LABEL: Record<ConsensusFlowFamily, string> = {
  sonnet: 'Sonnet',
  gemini: 'Gemini',
  opus: 'Opus',
  haiku: 'Haiku',
  other: 'Other',
};

const VERDICT_ORDER: ConsensusFlowVerdict[] = ['confirmed', 'disputed', 'unverified', 'unique'];

/** Hairline weight cutoff — ribbons below this are hidden but still counted. */
const MIN_VISIBLE_WEIGHT = 0.01;

export function ConsensusFlow({ consensusId, data: preloaded, onError }: ConsensusFlowProps) {
  // A valid consensusId with a fetched report — even if totalFindings === 0 —
  // renders the structural sankey (computeSankeyLayout gives every slot minH).
  // The 'empty' state is reserved for when no consensusId was provided.
  const [state, setState] = useState<FetchState>(
    preloaded
      ? { kind: 'full', data: preloaded }
      : consensusId
        ? { kind: 'loading' }
        : { kind: 'empty' }
  );

  useEffect(() => {
    if (preloaded) return;
    let cancelled = false;
    setState((prev) => (prev.kind === 'error' ? prev : { kind: 'loading' }));

    fetch(`/dashboard/api/consensus-flow?consensusId=${encodeURIComponent(consensusId)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
          throw new Error(msg);
        }
        return body as ConsensusFlowResponse;
      })
      .then((d) => {
        if (cancelled) return;
        setState({ kind: 'full', data: d });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState((prev) => ({
          kind: 'error',
          error: err.message,
          stale: prev.kind === 'full' ? prev.data : undefined,
        }));
        onError?.(err);
      });

    return () => { cancelled = true; };
  }, [consensusId, preloaded, onError]);

  if (state.kind === 'loading') return <ConsensusFlowSkeleton />;
  if (state.kind === 'empty') return <ConsensusFlowEmpty />;
  if (state.kind === 'error') {
    return (
      <ConsensusFlowError
        error={state.error}
        stale={state.stale}
      />
    );
  }
  return <ConsensusFlowChart data={state.data} />;
}

/* ── Full state ──────────────────────────────────────────────────────── */

function ConsensusFlowChart({ data }: { data: ConsensusFlowResponse }) {
  return (
    <div
      className="rounded-md border p-5"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-elev)' }}
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2
            className="font-mono text-[13px] font-semibold"
            style={{ color: 'var(--ink)' }}
          >
            Consensus flow
          </h2>
          <p
            className="mt-0.5 font-mono text-[11px]"
            style={{ color: 'var(--ink-3)' }}
          >
            {data.summary.totalFindings} findings across {data.agentCount} agents
          </p>
        </div>
        {data.coverageDegraded && (
          <CoverageDegradedChip degraded={data.coverageDegraded} />
        )}
      </header>

      {/* Horizontal sankey at ≥1024px */}
      <div className="hidden lg:block">
        <SankeyHorizontal data={data} />
      </div>
      {/* Stacked-bar at <1024px */}
      <div className="block lg:hidden">
        <StackedVertical data={data} />
      </div>

      <FlowLegend data={data} />
    </div>
  );
}

function CoverageDegradedChip({ degraded }: { degraded: NonNullable<ConsensusFlowResponse['coverageDegraded']> }) {
  return (
    <span
      className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]"
      style={{
        background: 'var(--warn-soft)',
        color: 'var(--warn)',
        border: '1px solid var(--warn)',
      }}
      data-tooltip={`Coverage degraded: expected ${degraded.expected}, received ${degraded.received}. Dropped: ${degraded.droppedAgents.join(', ') || 'none'}`}
    >
      coverage degraded
    </span>
  );
}

/* ── Horizontal sankey (≥1024px) ─────────────────────────────────────── */

const SVG_W = 720;
const SVG_H = 320;
const COL_W = 120;
const LEFT_X = 0;
const MID_X = (SVG_W - COL_W) / 2;
const RIGHT_X = SVG_W - COL_W;
const COL_PAD = 8;

interface BandSlot {
  family: ConsensusFlowFamily;
  y: number;
  h: number;
  agentCount: number;
}

interface VerdictSlot {
  verdict: ConsensusFlowVerdict;
  y: number;
  h: number;
  count: number;
}

function SankeyHorizontal({ data }: { data: ConsensusFlowResponse }) {
  const layout = useMemo(() => computeSankeyLayout(data), [data]);
  const ribbons = useMemo(() => layout.edges, [layout.edges]);
  const reduceMotion = usePrefersReducedMotion();

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        width="100%"
        height={SVG_H}
        role="img"
        aria-label={`Consensus flow: ${data.summary.confirmed} confirmed, ${data.summary.disputed} disputed, ${data.summary.unverified} unverified, ${data.summary.unique} unique of ${data.summary.totalFindings} findings across ${data.agentCount} agents`}
        style={{ display: 'block' }}
      >
        {/* TODO: ribbon-level keyboard focus (tabIndex + role="graphics-symbol")
            for full WCAG 2.1 SC 2.1.1 — out of scope for Step 7 fixup. */}
        {/* Ribbons */}
        <g>
          {ribbons.map((r, i) => (
            <path
              key={`${r.fromFamily}-${r.toVerdict}`}
              d={r.path}
              fill={r.color}
              fillOpacity={0.55}
              stroke="none"
              style={
                reduceMotion
                  ? undefined
                  : {
                      animation: `consensus-flow-ribbon-in 480ms ease-out ${i * 40}ms both`,
                    }
              }
            >
              <title>{r.tooltip}</title>
            </path>
          ))}
        </g>

        {/* Left bands: model families */}
        <g>
          {layout.left.map((band) => (
            <g key={band.family}>
              <rect
                x={LEFT_X}
                y={band.y}
                width={COL_W}
                height={band.h}
                fill="var(--ink-4)"
                fillOpacity={0.18}
              />
              <text
                x={LEFT_X + COL_W - 6}
                y={band.y + band.h / 2}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={11}
                fontFamily="var(--font-mono)"
                fill="var(--ink)"
              >
                {FAMILY_LABEL[band.family]} · {band.agentCount}
              </text>
            </g>
          ))}
        </g>

        {/* Middle column: verdict buckets */}
        <g>
          {layout.right.map((slot) => (
            <g key={slot.verdict}>
              <rect
                x={MID_X}
                y={slot.y}
                width={COL_W}
                height={slot.h}
                fill={VERDICT_COLOR[slot.verdict]}
                fillOpacity={0.16}
              />
              <text
                x={MID_X + COL_W / 2}
                y={slot.y + slot.h / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={11}
                fontFamily="var(--font-mono)"
                fill="var(--ink)"
                style={{ fontVariant: 'small-caps', letterSpacing: '0.04em' }}
              >
                {VERDICT_LABEL[slot.verdict]} · {slot.count}
              </text>
            </g>
          ))}
        </g>

        {/* Right column: outcome rects */}
        <g>
          {layout.right.map((slot) => {
            const pct = data.summary.totalFindings > 0
              ? Math.round((slot.count / data.summary.totalFindings) * 100)
              : 0;
            return (
              <g key={slot.verdict}>
                <rect
                  x={RIGHT_X}
                  y={slot.y}
                  width={COL_W}
                  height={slot.h}
                  fill={VERDICT_COLOR[slot.verdict]}
                  fillOpacity={0.32}
                />
                <text
                  x={RIGHT_X + COL_W - 6}
                  y={slot.y + slot.h / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={11}
                  fontFamily="var(--font-mono)"
                  fill="var(--ink)"
                >
                  {slot.count} · {pct}%
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <style>{`
        @keyframes consensus-flow-ribbon-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          svg * { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

interface RibbonRender {
  path: string;
  color: string;
  tooltip: string;
  fromFamily: ConsensusFlowFamily;
  toVerdict: ConsensusFlowVerdict;
}

interface SankeyLayout {
  left: BandSlot[];
  right: VerdictSlot[];
  edges: RibbonRender[];
}

function computeSankeyLayout(data: ConsensusFlowResponse): SankeyLayout {
  const total = data.summary.totalFindings;
  const usableH = SVG_H - COL_PAD * 2;

  // Per-family finding totals — drives left band sizing AND ribbon stacking
  // (matches the right column's finding-count denominator so ribbons fit).
  const familyTotalsByVerdict = new Map<ConsensusFlowFamily, number>();
  for (const e of data.familyToOutcome) {
    familyTotalsByVerdict.set(
      e.from.family,
      (familyTotalsByVerdict.get(e.from.family) ?? 0) + e.to.count,
    );
  }

  // LEFT bands sized by finding flow originating from each family.
  const leftTotal = data.modelFamilyToFindings.reduce(
    (s, b) => s + (familyTotalsByVerdict.get(b.family) ?? 0), 0,
  ) || 1;
  let cursorL = COL_PAD;
  const left: BandSlot[] = data.modelFamilyToFindings.map((b) => {
    const findings = familyTotalsByVerdict.get(b.family) ?? 0;
    const h = Math.max(20, (findings / leftTotal) * usableH);
    const slot: BandSlot = { family: b.family, y: cursorL, h, agentCount: b.agentCount };
    cursorL += h;
    return slot;
  });

  // RIGHT verdict slots sized by count; empty buckets get a thin slot
  // (DESIGN.md spec: maintain structure, don't collapse).
  const minH = 24;
  let cursorR = COL_PAD;
  const right: VerdictSlot[] = VERDICT_ORDER.map((verdict) => {
    const count = data.summary[verdict];
    const ratio = total > 0 ? count / total : 0;
    const h = Math.max(minH, ratio * usableH);
    const slot: VerdictSlot = { verdict, y: cursorR, h, count };
    cursorR += h;
    return slot;
  });

  // Edges (sub-bands of left/right).
  // Track per-band cumulative offset so multiple outgoing ribbons stack
  // proportionally within the band.
  const leftOffset = new Map<ConsensusFlowFamily, number>();
  const rightOffset = new Map<ConsensusFlowVerdict, number>();

  const edges: RibbonRender[] = [];
  // Pre-sort edges to be drawn in stable family→verdict order.
  const sortedEdges: ConsensusFlowEdge[] = [...data.familyToOutcome].sort((a, b) => {
    if (a.from.family !== b.from.family) return a.from.family.localeCompare(b.from.family);
    return VERDICT_ORDER.indexOf(a.to.verdict) - VERDICT_ORDER.indexOf(b.to.verdict);
  });

  for (const e of sortedEdges) {
    const lBand = left.find((b) => b.family === e.from.family);
    const rSlot = right.find((s) => s.verdict === e.to.verdict);
    if (!lBand || !rSlot) continue;

    const lTotal = familyTotalsByVerdict.get(e.from.family) ?? 0;
    const lRibbonH = lTotal > 0 ? (e.to.count / lTotal) * lBand.h : 0;
    const rTotal = rSlot.count || 1;
    const rRibbonH = (e.to.count / rTotal) * rSlot.h;

    // Advance cursors for EVERY edge — even sub-MIN_VISIBLE_WEIGHT skipped
    // ones — so the band's bottom doesn't show a gap when ribbons are hidden.
    const lOff = leftOffset.get(e.from.family) ?? 0;
    const rOff = rightOffset.get(e.to.verdict) ?? 0;
    leftOffset.set(e.from.family, lOff + lRibbonH);
    rightOffset.set(e.to.verdict, rOff + rRibbonH);

    if (e.weight < MIN_VISIBLE_WEIGHT) continue;

    const y0a = lBand.y + lOff;
    const y0b = y0a + lRibbonH;
    const y1a = rSlot.y + rOff;
    const y1b = y1a + rRibbonH;

    const xa = LEFT_X + COL_W;
    const xb = MID_X;
    const cxa = xa + (xb - xa) * 0.5;
    const cxb = xb - (xb - xa) * 0.5;

    const path =
      `M ${xa} ${y0a} ` +
      `C ${cxa} ${y0a}, ${cxb} ${y1a}, ${xb} ${y1a} ` +
      `L ${xb} ${y1b} ` +
      `C ${cxb} ${y1b}, ${cxa} ${y0b}, ${xa} ${y0b} ` +
      `Z`;

    const famBand = data.modelFamilyToFindings.find((b) => b.family === e.from.family);
    const famCount = famBand?.agentCount ?? 0;
    edges.push({
      path,
      color: VERDICT_COLOR[e.to.verdict],
      tooltip: `${famCount} ${FAMILY_LABEL[e.from.family]} agent${famCount === 1 ? '' : 's'} → ${e.to.count} ${VERDICT_LABEL[e.to.verdict]} finding${e.to.count === 1 ? '' : 's'} (${Math.round(e.weight * 100)}%)`,
      fromFamily: e.from.family,
      toVerdict: e.to.verdict,
    });
  }

  return { left, right, edges };
}

/* ── Vertical stacked (<1024px) ──────────────────────────────────────── */

function StackedVertical({ data }: { data: ConsensusFlowResponse }) {
  const total = data.summary.totalFindings || 1;
  return (
    <div className="space-y-4">
      <StackedRow
        label="Model families"
        items={data.modelFamilyToFindings.map((b) => ({
          key: b.family,
          label: `${FAMILY_LABEL[b.family]} (${b.agentCount})`,
          value: b.agentCount,
          color: 'var(--ink-4)',
        }))}
      />
      <StackedRow
        label="Findings reviewed"
        items={VERDICT_ORDER.map((v) => ({
          key: v,
          label: `${VERDICT_LABEL[v]} (${data.summary[v]})`,
          value: data.summary[v],
          color: VERDICT_COLOR[v],
        }))}
      />
      <StackedRow
        label="Outcome verdicts"
        items={VERDICT_ORDER.map((v) => ({
          key: v,
          label: `${data.summary[v]} · ${Math.round((data.summary[v] / total) * 100)}%`,
          value: data.summary[v],
          color: VERDICT_COLOR[v],
        }))}
      />
    </div>
  );
}

interface StackedItem {
  key: string;
  label: string;
  value: number;
  color: string;
}

function StackedRow({ label, items }: { label: string; items: StackedItem[] }) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return (
    <div>
      <div
        className="mb-1 text-[10px]"
        style={{
          color: 'var(--ink-3)',
          fontFamily: 'var(--font-sans)',
          fontVariant: 'small-caps',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </div>
      <div
        className="flex h-6 overflow-hidden rounded-sm border"
        style={{ borderColor: 'var(--border)' }}
      >
        {items.map((item) => {
          const pct = (item.value / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={item.key}
              title={item.label}
              style={{
                width: `${pct}%`,
                background: item.color,
                opacity: 0.7,
                color: 'var(--surface)',
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              {pct > 12 ? item.label : ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Legend ──────────────────────────────────────────────────────────── */

function FlowLegend({ data }: { data: ConsensusFlowResponse }) {
  return (
    <div
      className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 font-mono text-[10px]"
      style={{ borderColor: 'var(--border)', color: 'var(--ink-3)' }}
    >
      {VERDICT_ORDER.map((v) => (
        <span key={v} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: VERDICT_COLOR[v] }}
          />
          {VERDICT_LABEL[v]} · {data.summary[v]}
        </span>
      ))}
      {data.summary.newFindings > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: 'var(--warn)' }}
          />
          new · {data.summary.newFindings}
        </span>
      )}
    </div>
  );
}

/* ── States ──────────────────────────────────────────────────────────── */

function ConsensusFlowSkeleton() {
  return (
    <div
      className="rounded-md border p-5"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-elev)' }}
      aria-busy="true"
      aria-label="Loading consensus flow"
    >
      <div className="mb-4 space-y-2">
        <div
          className="h-3 w-32 animate-pulse rounded-sm"
          style={{ background: 'var(--border)' }}
        />
        <div
          className="h-2 w-48 animate-pulse rounded-sm"
          style={{ background: 'var(--border)' }}
        />
      </div>
      <div className="grid grid-cols-3 gap-3" style={{ height: SVG_H }}>
        {[0, 1, 2].map((col) => (
          <div key={col} className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                className="flex-1 animate-pulse rounded-sm"
                style={{
                  background: 'var(--border)',
                  opacity: 0.6,
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .animate-pulse { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

function ConsensusFlowEmpty() {
  return (
    <div
      className="rounded-md border p-10 text-center"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-elev)' }}
    >
      <p
        className="font-mono text-[12px]"
        style={{ color: 'var(--ink-3)' }}
      >
        No consensus rounds yet — dispatch your first review to see the consensus flow.
      </p>
    </div>
  );
}

function ConsensusFlowError({
  error,
  stale,
}: {
  error: string;
  stale?: ConsensusFlowResponse;
}) {
  return (
    <div
      className="relative rounded-md border p-5"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-elev)' }}
    >
      <div className="absolute right-3 top-3">
        <span
          className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]"
          style={{
            background: 'var(--bad-soft)',
            color: 'var(--bad)',
            border: '1px solid var(--bad)',
          }}
          title={error}
        >
          error · {error}
        </span>
      </div>
      {stale ? (
        <div style={{ opacity: 0.5, pointerEvents: 'none' }}>
          <ConsensusFlowChart data={stale} />
        </div>
      ) : (
        <p
          className="py-10 text-center font-mono text-[12px]"
          style={{ color: 'var(--ink-3)' }}
        >
          Failed to load consensus flow.
        </p>
      )}
    </div>
  );
}

/* ── prefers-reduced-motion ──────────────────────────────────────────── */

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduce;
}
