interface CategoryStrengthsProps {
  strengths: Record<string, number>;
}

export function CategoryStrengths({ strengths }: CategoryStrengthsProps) {
  const entries = Object.entries(strengths)
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
