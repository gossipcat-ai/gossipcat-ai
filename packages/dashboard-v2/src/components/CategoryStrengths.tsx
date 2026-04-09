import { EmptyState } from './EmptyState';

interface CategoryStrengthsProps {
  /** Raw severity-weighted accumulator from performance-reader. Unbounded — used as sort fallback only. */
  strengths: Record<string, number>;
  /** c / (c + h) ratio in [0,1]. Gated on MIN_CATEGORY_N (5) server-side. */
  accuracy?: Record<string, number>;
  /** Raw correct count per category. Used to render "(c/n)" tuples. */
  correctCounts?: Record<string, number>;
  /** Raw hallucinated count per category. Used to render "(c/n)" tuples. */
  hallucinatedCounts?: Record<string, number>;
}

const MIN_CATEGORY_N = 5;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

interface CategoryRow {
  category: string;
  score: number;
  c: number;
  n: number;
  sparse: boolean;
}

export function CategoryStrengths({ strengths, accuracy, correctCounts, hallucinatedCounts }: CategoryStrengthsProps) {
  // Build rows from the union of all category keys so sparse categories (dropped
  // from accuracy server-side) can still render as dimmed "needs more data" rows
  // instead of vanishing silently. The user sees "trust_boundaries — sparse"
  // rather than "trust_boundaries — 100% 🎉" based on 1 correct signal.
  const categoryKeys = new Set<string>([
    ...Object.keys(strengths),
    ...(accuracy ? Object.keys(accuracy) : []),
    ...(correctCounts ? Object.keys(correctCounts) : []),
    ...(hallucinatedCounts ? Object.keys(hallucinatedCounts) : []),
  ]);

  const rows: CategoryRow[] = [];
  for (const category of categoryKeys) {
    const c = correctCounts?.[category] ?? 0;
    const h = hallucinatedCounts?.[category] ?? 0;
    const n = c + h;
    const sparse = n < MIN_CATEGORY_N;

    // Score priority: accuracy from server (gated) > computed c/n > clamped strengths fallback
    let score: number;
    if (accuracy && accuracy[category] !== undefined) {
      score = clamp01(accuracy[category]);
    } else if (n > 0) {
      score = clamp01(c / n);
    } else {
      score = clamp01(strengths[category] ?? 0);
    }

    rows.push({ category, score, c, n, sparse });
  }

  // Non-sparse first (sorted by score desc), then sparse rows at the bottom.
  rows.sort((a, b) => {
    if (a.sparse !== b.sparse) return a.sparse ? 1 : -1;
    return b.score - a.score;
  });

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No category data yet"
        hint="Category signals accrue after the first consensus round."
        compact
      />
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          key={row.category}
          className={`flex items-center gap-3 ${row.sparse ? 'opacity-40' : ''}`}
          title={row.sparse ? `Only ${row.n} signal${row.n === 1 ? '' : 's'} in this category — needs ≥${MIN_CATEGORY_N} for a trustworthy accuracy.` : `${row.c} correct / ${row.n} total`}
        >
          <span className="w-32 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
            {row.category.replace(/_/g, ' ')}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/30">
            <div
              className="h-full rounded-full bg-chart/70 transition-all"
              style={{ width: `${row.score * 100}%` }}
            />
          </div>
          <span className="shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/70 w-16">
            {row.sparse && row.n === 0
              ? '—'
              : `${row.c}/${row.n}`}
          </span>
          <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">
            {row.sparse ? <span className="text-muted-foreground/50">sparse</span> : `${Math.round(row.score * 100)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}
