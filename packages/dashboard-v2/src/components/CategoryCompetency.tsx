import { EmptyState } from './EmptyState';

interface Props {
  categoryAccuracy?: Record<string, number>;
  categoryCorrect?: Record<string, number>;
  categoryHallucinated?: Record<string, number>;
}

/** Horizontal bars per category. Shows raw `c/(c+h)` accuracy — the
 * honest per-category success rate — with hallucination count visible
 * as a `·N✗` badge in the tuple so the composition isn't hidden.
 *
 * Previous revisions tried to apply the global `1/(1+h*0.3)` penalty
 * per-category to match the scorecard's 0.37-style overall accuracy,
 * but that formula is calibrated for overall signal counts (10–50
 * lifetime), not category slices with 100+ signals. On a 145/147
 * category, 2 hallucinations = 1.4% error rate — genuinely near-perfect.
 * Applying the multiplier dragged it to 62%, which was misleading in
 * the opposite direction. Honest raw display with halluc count wins.
 *
 * The scorecard's overall weighted accuracy is shown elsewhere; this
 * widget answers "where does this agent do well?" not "how much do I
 * trust this agent overall?" — two different questions. */
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
      const acc = Math.max(0, Math.min(1, categoryAccuracy![k] ?? 0));
      const c = categoryCorrect?.[k] ?? 0;
      const h = categoryHallucinated?.[k] ?? 0;
      return { key: k, acc, c, h, n: c + h };
    })
    .sort((a, b) => b.acc - a.acc);

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const fill = row.acc >= 0.7 ? 'bg-confirmed' : row.acc >= 0.4 ? 'bg-unverified' : 'bg-disputed';
        const title = row.n > 0
          ? `${row.c} correct / ${row.h} hallucinated / ${row.n} total`
          : undefined;
        return (
          <div
            key={row.key}
            className={`grid grid-cols-[128px_1fr_auto_44px] items-center gap-3 ${row.n > 0 && row.n < 10 ? 'opacity-50' : ''}`}
            title={row.n > 0 && row.n < 10 ? `${title} — low sample (n<10)` : title}
          >
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {row.key.replace(/_/g, ' ')}
            </span>
            <div className="h-2 overflow-hidden rounded-sm bg-muted/30">
              <div
                className={`h-full rounded-sm transition-all ${fill}`}
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
