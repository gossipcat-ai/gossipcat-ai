import { agentColor } from '@/lib/utils';

/**
 * SignalsByAgent — compact per-agent signal breakdown for SessionRail.
 *
 * Renders under the "signals · {total} · 24h" row in the SESSION rail.
 * Data: agents array from SignalActivityResponse (already fetched; no extra call).
 *
 * Design rules (DESIGN.md):
 *  - Small-caps Geist sub-label ("by agent") — ink-4 / decorative
 *  - font-mono agent ids + counts (JetBrains Mono)
 *  - Per-agent identity color (agentColor(id)) ONLY in the proportional bar fill
 *  - No --accent, no drop shadows, hairline --border-only track
 *  - --ink-3 for counts, --ink-4 for bar track + decorative text
 *  - Cap to top 8 by count (there are ~9 agents); skip count=0 rows
 */

const MAX_AGENTS = 8;

interface AgentBucket {
  id: string;
  buckets: number[];
}

interface SignalsByAgentProps {
  agents: AgentBucket[];
}

export function SignalsByAgent({ agents }: SignalsByAgentProps) {
  // Sum 24h buckets per agent, sort descending, cap at MAX_AGENTS, drop zeros.
  const rows = agents
    .map((a) => ({ id: a.id, count: a.buckets.reduce((s, n) => s + n, 0) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_AGENTS);

  if (rows.length === 0) {
    // all-zero or empty: render nothing (consistent with task — "render nothing/subtle —")
    return null;
  }

  const maxCount = rows[0].count; // already sorted descending

  return (
    <div style={{ marginTop: '6px' }}>
      {/* Sub-label: small-caps Geist, ink-4 (decorative, non-text per DESIGN.md) */}
      <span
        style={{
          display: 'block',
          fontSize: '10px',
          fontVariant: 'small-caps',
          letterSpacing: '0.04em',
          color: 'var(--ink-4)',
          marginBottom: '6px',
        }}
      >
        by agent
      </span>

      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        {rows.map(({ id, count }) => {
          const barPct = maxCount > 0 ? count / maxCount : 0;
          const color = agentColor(id);

          return (
            <li
              key={id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '3px',
              }}
            >
              {/* id + count row */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: '6px',
                  minWidth: 0,
                }}
              >
                <span
                  className="font-mono text-[10px]"
                  style={{
                    color: 'var(--ink-3)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: '1 1 0',
                    minWidth: 0,
                  }}
                  title={id}
                >
                  {id}
                </span>
                <span
                  className="font-mono text-[10px]"
                  style={{
                    color: 'var(--ink-3)',
                    flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {count}
                </span>
              </div>

              {/* Proportional bar — identity color in fill only; track uses --border */}
              <div
                style={{
                  height: '2px',
                  borderRadius: '1px',
                  background: 'var(--border)',
                  overflow: 'hidden',
                }}
                aria-hidden
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.round(barPct * 100)}%`,
                    background: color,
                    borderRadius: '1px',
                    transition: 'width 200ms ease-out',
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
