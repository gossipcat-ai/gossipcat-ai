/**
 * DESIGN.md "Error" state contract — full-card chip in mono small with the
 * error reason. Sits next to the section header (top-right of the card) so
 * stale cached data underneath can render at 50% opacity, signaling
 * "we know this is potentially out of date" without destroying the user's
 * context.
 *
 * Used by RecentSignalsPeek / SkillGraduationGrid / FindingDetailDrawer.
 * Consumers are responsible for the opacity dim on the cached data; this
 * component only provides the chip itself.
 *
 * Pairs with role="alert" so screen readers announce the error inline; the
 * leading `!` is decorative (aria-hidden) to keep the SR text clean.
 */

interface ErrorChipProps {
  message: string;
  /** Tailwind classes appended to the chip — e.g. ml-auto / mt-1 for positioning. */
  className?: string;
}

export function ErrorChip({ message, className }: ErrorChipProps) {
  return (
    <span
      role="alert"
      className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-mono text-[10px] ${className ?? ''}`}
      style={{
        color: 'var(--bad)',
        background: 'color-mix(in oklch, var(--bad) 12%, transparent)',
        border: '1px solid color-mix(in oklch, var(--bad) 30%, transparent)',
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>!</span>
      <span>error · {message}</span>
    </span>
  );
}
