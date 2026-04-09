interface CategoryStrengthsProps {
  /** Raw severity-weighted accumulator from performance-reader. Unbounded — used as sort fallback only. */
  strengths: Record<string, number>;
  /** c / (c + h) ratio in [0,1]. Preferred data source when available. */
  accuracy?: Record<string, number>;
}

// Clamp any score to [0, 1] before turning it into a percentage. Guards against
// stale clients rendering categoryStrengths (unbounded) as a ratio.
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function CategoryStrengths({ strengths, accuracy }: CategoryStrengthsProps) {
  // Prefer categoryAccuracy (real c/(c+h) ratio) over categoryStrengths (unbounded
  // severity-weighted accumulator used for dispatch routing). Fall back to clamped
  // strengths when accuracy is unavailable for back-compat with older server builds.
  const source = accuracy && Object.keys(accuracy).length > 0 ? accuracy : strengths;
  const entries = Object.entries(source)
    .map(([k, v]) => [k, clamp01(v)] as [string, number])
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        No category data yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map(([category, score]) => (
        <div key={category} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
            {category.replace(/_/g, ' ')}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/30">
            <div
              className={`h-full rounded-full transition-all ${
                score >= 0.7 ? 'bg-confirmed' : score >= 0.4 ? 'bg-unverified' : 'bg-disputed'
              }`}
              style={{ width: `${score * 100}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right font-mono text-[11px] text-foreground">
            {Math.round(score * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}
