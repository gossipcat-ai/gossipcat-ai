/**
 * SignalsByAgent — per-agent polarity bar for SessionRail.
 *
 * Renders under the "signals · {total} · 24h" row in the SESSION rail.
 * Data: agents array from GET /dashboard/api/agents (fetched by SessionRail).
 *
 * Design rules (DESIGN.md):
 *  - Small-caps Geist sub-label ("by agent") — ink-4 / decorative
 *  - font-mono agent ids + counts (JetBrains Mono)
 *  - TWO-SEGMENT bar: positive (--ok green) + negative (--bad rose)
 *  - Track = var(--border) hairline
 *  - Semantic colors only — NO agentColor / identity colors
 *  - No --accent, no drop shadows
 *  - --ink-3 for counts, --ink-4 for bar track + decorative text
 *  - Sort by total DESC, top 8, total>0 only
 *
 * Positive = agreements + uniqueFindings (confirmed/unique good signals)
 * Negative = hallucinations + disagreements (disputed/bad signals)
 */

const MAX_AGENTS = 8;

/** Minimal slice of AgentResponse.scores we consume — avoids importing heavy AgentData type. */
interface AgentScoreSlice {
  agreements: number;
  uniqueFindings: number;
  hallucinations: number;
  disagreements: number;
}

interface AgentEntry {
  id: string;
  scores: AgentScoreSlice;
}

interface SignalsByAgentProps {
  agents: AgentEntry[];
}

export function SignalsByAgent({ agents }: SignalsByAgentProps) {
  // Compute polarity totals per agent, sort descending by total, cap at MAX_AGENTS, drop zeros.
  const rows = agents
    .map((a) => {
      const pos = (a.scores.agreements ?? 0) + (a.scores.uniqueFindings ?? 0);
      const neg = (a.scores.hallucinations ?? 0) + (a.scores.disagreements ?? 0);
      const total = pos + neg;
      return { id: a.id, pos, neg, total };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_AGENTS);

  if (rows.length === 0) {
    // all-zero or empty: omit breakdown entirely
    return null;
  }

  const maxTotal = rows[0].total; // already sorted descending

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
          gap: '5px',
        }}
      >
        {rows.map(({ id, pos, neg, total }) => {
          // Scale bar length relative to the agent with the highest total.
          // The bar track width is proportional to total/maxTotal.
          const trackPct = maxTotal > 0 ? total / maxTotal : 0;
          // Within that scaled track, split positive vs negative by their share.
          const posPct = total > 0 ? pos / total : 0;
          const negPct = total > 0 ? neg / total : 0;

          return (
            <li
              key={id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '3px',
              }}
            >
              {/* id + polarity count row */}
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
                {/* ↑pos ↓neg counts — font-mono tabular-nums */}
                <span
                  className="font-mono text-[10px]"
                  style={{
                    flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {pos > 0 && (
                    <span style={{ color: 'var(--ok)' }}>↑{pos}</span>
                  )}
                  {pos > 0 && neg > 0 && (
                    <span style={{ color: 'var(--ink-4)', margin: '0 2px' }}> </span>
                  )}
                  {neg > 0 && (
                    <span style={{ color: 'var(--bad)' }}>↓{neg}</span>
                  )}
                </span>
              </div>

              {/* Two-segment proportional bar
                  - outer track is scaled to total/maxTotal of available width
                  - inside track: positive (--ok) then negative (--bad) side-by-side
                  - track background = --border
              */}
              <div
                style={{
                  height: '3px',
                  borderRadius: '1.5px',
                  background: 'var(--border)',
                  overflow: 'hidden',
                }}
                aria-hidden
              >
                {/* Scaled outer wrapper — length ∝ total/maxTotal */}
                <div
                  style={{
                    height: '100%',
                    width: `${Math.round(trackPct * 100)}%`,
                    display: 'flex',
                    borderRadius: '1.5px',
                    overflow: 'hidden',
                    transition: 'width 200ms ease-out',
                  }}
                >
                  {/* Positive segment — --ok green */}
                  {pos > 0 && (
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.round(posPct * 100)}%`,
                        background: 'var(--ok)',
                        flexShrink: 0,
                      }}
                    />
                  )}
                  {/* Negative segment — --bad rose */}
                  {neg > 0 && (
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.round(negPct * 100)}%`,
                        background: 'var(--bad)',
                        flexShrink: 0,
                      }}
                    />
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
