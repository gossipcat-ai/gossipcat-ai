import { EmptyState } from './EmptyState';

interface Props {
  categoryAccuracy?: Record<string, number>;
  categoryCorrect?: Record<string, number>;
  categoryHallucinated?: Record<string, number>;
}

// Matches the overall-accuracy hallucinationMultiplier at
// `performance-reader.ts:705` — `1 / (1 + h * 0.3)`. Applying it per-category
// keeps this widget consistent with the scorecard: a category with zero
// hallucinations keeps its raw accuracy; hallucinations drag the bar the
// same way they drag the overall score. Previously the widget showed raw
// `c/(c+h)` which read 95% on a category with 3 hallucinations, even when
// the agent's overall accuracy was 0.37 — confusing UX.
function penalize(rawAcc: number, h: number): number {
  const multiplier = 1 / (1 + h * 0.3);
  return Math.max(0, Math.min(1, rawAcc * multiplier));
}

/** Horizontal bars per category. Each bar shows the WEIGHTED accuracy
 * (raw ratio × hallucination-penalty, mirroring the global accuracy
 * formula). Raw c/n + hallucination count shown in the tuple so the
 * composition is visible. */
export function CategoryCompetency({ categoryAccuracy, categoryCorrect, categoryHallucinated }: Props) {
  const keys = Object.keys(categoryAccuracy ?? {});
  if (keys.length === 0) {
    return (
      <EmptyState
        title="No category data yet"
        hint="Accuracy accrues after ≥5 signals per category."
        compact
      />
    );
  }

  const rows = keys
    .map((k) => {
      const rawAcc = Math.max(0, Math.min(1, categoryAccuracy![k] ?? 0));
      const c = categoryCorrect?.[k] ?? 0;
      const h = categoryHallucinated?.[k] ?? 0;
      const acc = penalize(rawAcc, h);
      return { key: k, rawAcc, acc, c, h, n: c + h };
    })
    .sort((a, b) => b.acc - a.acc);

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const fill = row.acc >= 0.7 ? 'bg-confirmed' : row.acc >= 0.4 ? 'bg-unverified' : 'bg-disputed';
        const rawDelta = Math.round((row.rawAcc - row.acc) * 100);
        const rawPct = Math.round(row.rawAcc * 100);
        const title =
          row.n > 0
            ? `${row.c} correct / ${row.h} hallucinated / ${row.n} total — raw ${rawPct}%${rawDelta > 0 ? `, penalized −${rawDelta}pp for ${row.h} hallucination${row.h === 1 ? '' : 's'}` : ''}`
            : undefined;
        return (
          <div
            key={row.key}
            className="grid grid-cols-[128px_1fr_auto_44px] items-center gap-3"
            title={title}
          >
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {row.key.replace(/_/g, ' ')}
            </span>
            <div className="relative h-2 overflow-hidden rounded-sm bg-muted/30">
              {/* Ghost bar at raw accuracy shows the unweighted position,
                  so a category with penalty has a visible gap between
                  the ghost (muted/light) and the weighted fill. */}
              {row.h > 0 && row.rawAcc > row.acc && (
                <div
                  className="absolute inset-y-0 left-0 rounded-sm bg-muted/50"
                  style={{ width: `${row.rawAcc * 100}%` }}
                />
              )}
              <div
                className={`absolute inset-y-0 left-0 h-full rounded-sm transition-all ${fill}`}
                style={{ width: `${row.acc * 100}%` }}
              />
            </div>
            <span className="shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60 w-16">
              {row.n > 0 ? (
                <>
                  {row.c}/{row.n}
                  {row.h > 0 && <span className="ml-1 text-disputed/70">·{row.h}✗</span>}
                </>
              ) : (
                '—'
              )}
            </span>
            <span className="text-right font-mono text-[11px] font-bold tabular-nums text-foreground">
              {Math.round(row.acc * 100)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
