import { EmptyState } from './EmptyState';

interface Props {
  categoryAccuracy?: Record<string, number>;
  categoryCorrect?: Record<string, number>;
  categoryHallucinated?: Record<string, number>;
}

/** Horizontal bars per category with accuracy %. Reads categoryAccuracy
 * (server-gated ratio in [0,1]) and renders one row per category with
 * optional "(c/n)" tuple when raw counts are available. */
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
      return { key: k, acc, c, n: c + h };
    })
    .sort((a, b) => b.acc - a.acc);

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const fill = row.acc >= 0.7 ? 'bg-confirmed' : row.acc >= 0.4 ? 'bg-unverified' : 'bg-disputed';
        return (
          <div
            key={row.key}
            className="grid grid-cols-[128px_1fr_auto_44px] items-center gap-3"
            title={row.n > 0 ? `${row.c} correct / ${row.n} total` : undefined}
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
            <span className="shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60 w-12">
              {row.n > 0 ? `${row.c}/${row.n}` : '—'}
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
