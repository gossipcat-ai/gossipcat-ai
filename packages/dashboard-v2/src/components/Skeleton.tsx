/**
 * Skeleton — static placeholder blocks for loading states.
 *
 * Design contract (DESIGN.md §State Coverage):
 * - Color: --border at ~40% opacity
 * - No animation library; no spinners
 * - Blocks approximate the shape and density of the real content
 */

interface SkeletonBlockProps {
  className?: string;
  style?: React.CSSProperties;
}

/** Single skeleton rectangle. */
export function SkeletonBlock({ className = '', style }: SkeletonBlockProps) {
  return (
    <div
      className={`rounded ${className}`}
      style={{
        background: 'color-mix(in oklch, var(--border) 40%, transparent)',
        ...style,
      }}
    />
  );
}

/** A skeleton row: one narrow block (label-width) + one wider block (value-width). */
export function SkeletonRow({ labelW = 'w-24', valueW = 'w-40' }: { labelW?: string; valueW?: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <SkeletonBlock className={`h-3 ${labelW}`} />
      <SkeletonBlock className={`h-3 ${valueW}`} />
    </div>
  );
}

/**
 * OverviewSkeleton — approximates the Overview page layout:
 * - A SystemPulse-shaped wide rect (hero area)
 * - 3 widget-height rects (grid row)
 */
export function OverviewSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      {/* Hero: SystemPulse-shaped wide rect */}
      <SkeletonBlock className="h-48 w-full" />
      {/* Three widget-height rects */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SkeletonBlock className="h-36" />
        <SkeletonBlock className="h-36" />
        <SkeletonBlock className="h-36" />
      </div>
      {/* A lower content row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SkeletonBlock className="h-48" />
        <SkeletonBlock className="h-48" />
      </div>
    </div>
  );
}

/**
 * TeamPageSkeleton — approximates the Team page layout:
 * - A stat strip (4 cells)
 * - A table-like block
 */
export function TeamPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="mb-6">
        <SkeletonBlock className="mb-2 h-7 w-32" />
        <SkeletonBlock className="h-3 w-48" />
      </div>
      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-16" />
        ))}
      </div>
      {/* Table rows */}
      <div className="space-y-px overflow-hidden rounded-md">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-12" />
        ))}
      </div>
    </div>
  );
}

/**
 * TasksPageSkeleton — approximates the Tasks page layout:
 * - A header row
 * - A list of task rows
 */
export function TasksPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="mb-6">
        <SkeletonBlock className="mb-2 h-7 w-24" />
        <SkeletonBlock className="h-3 w-32" />
      </div>
      <div className="space-y-px overflow-hidden rounded-md">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-11" />
        ))}
      </div>
    </div>
  );
}

/**
 * DebatesPageSkeleton — approximates the Consensus Rounds (Debates) page layout:
 * - A header
 * - Cards/rows of finding blocks
 */
export function DebatesPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="mb-6">
        <SkeletonBlock className="mb-2 h-7 w-48" />
        <SkeletonBlock className="h-3 w-64" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-md">
            <SkeletonBlock className="h-14" />
            <div className="mt-px space-y-px">
              {Array.from({ length: 3 }).map((_, j) => (
                <SkeletonBlock key={j} className="h-10" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * AgentMemorySkeleton — approximates the memory panel rows in AgentPage.
 */
export function AgentMemorySkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 py-2">
          <SkeletonBlock className="mt-0.5 h-4 w-4 shrink-0 rounded-sm" />
          <div className="flex-1 space-y-1.5">
            <SkeletonBlock className="h-3 w-3/4" />
            <SkeletonBlock className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * AgentReportsSkeleton — approximates the consensus-reports rows in AgentPage.
 */
export function AgentReportsSkeleton() {
  return (
    <div className="space-y-px overflow-hidden rounded-md">
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonBlock key={i} className="h-10" />
      ))}
    </div>
  );
}
