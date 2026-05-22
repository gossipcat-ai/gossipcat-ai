/**
 * Shared empty-state shell. Every panel on the dashboard used to render an
 * empty state as a single centered muted sentence ("No memories yet."), which
 * is indistinguishable from "broken" to a first-run user. This component adds
 * a short next-action hint so empty panels feel intentional rather than
 * missing data.
 *
 * Usage: <EmptyState title="No tasks yet" hint="Dispatch via gossip_run." />
 */
interface EmptyStateProps {
  title: string;
  hint?: string;
  /** Override padding if the host panel is already tight. */
  compact?: boolean;
}

export function EmptyState({ title, hint, compact = false }: EmptyStateProps) {
  return (
    <div className={`text-center ${compact ? 'py-3' : 'py-6'}`}>
      <div className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{title}</div>
      {hint && (
        <div className="mt-1 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}
