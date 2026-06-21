/**
 * Canonical task status constants shared between TaskRow.tsx and TasksSection.tsx.
 * Extract here to avoid duplicating normaliseStatus / STATUS_META / STATUS_ICON
 * across two components that must render the same visual language.
 */
import type { JSX } from 'react';
import type React from 'react';

/** The five canonical status buckets the indicator renders. */
export type StatusKey = 'completed' | 'running' | 'failed' | 'cancelled' | 'unknown';

/**
 * Normalise a free-form task status into one of our canonical buckets. The
 * TaskItem type currently narrows to four literals, but collect/relay can
 * surface aliases ("done", "error", "in_progress", etc.) — we fold those in
 * rather than letting them fall through to the gray "unknown" fallback.
 */
export function normaliseStatus(status: string): StatusKey {
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'done' || s === 'success' || s === 'succeeded') return 'completed';
  if (s === 'running' || s === 'active' || s === 'in_progress' || s === 'pending') return 'running';
  if (s === 'failed' || s === 'error' || s === 'errored' || s === 'timeout' || s === 'timed_out') return 'failed';
  if (s === 'cancelled' || s === 'canceled' || s === 'queued' || s === 'waiting') return 'cancelled';
  return 'unknown';
}

/**
 * Per-status visual treatment: label, icon box tint, text color, and whether
 * the icon box animates. Mirrors the MemoryFolders icon-box pattern (faint
 * tinted background + 1px border ring in the same hue) so the dashboard's
 * semantic palette stays consistent across panels.
 */
export const STATUS_META: Record<StatusKey, {
  label: string;
  iconBox: string;   // bg tint + border ring on the status icon square
  text: string;      // icon stroke + label color
  textStyle?: React.CSSProperties;
  pulse: boolean;    // subtle breathing outline for in-flight tasks
}> = {
  completed: {
    label: 'Done',
    iconBox: 'bg-confirmed/10 border-confirmed/30',
    text: 'text-confirmed',
    pulse: false,
  },
  running: {
    label: 'Running',
    iconBox: 'bg-unverified/10 border-unverified/30',
    text: 'text-unverified',
    pulse: true,
  },
  failed: {
    label: 'Failed',
    iconBox: 'bg-bad/10 border-bad/30',
    text: 'text-bad',
    pulse: false,
  },
  cancelled: {
    label: 'Cancelled',
    iconBox: 'border-muted-foreground/25',
    text: '',
    textStyle: { color: 'var(--text-dim)', background: 'color-mix(in oklch, var(--text-dim) 10%, transparent)' },
    pulse: false,
  },
  unknown: {
    label: 'Unknown',
    iconBox: 'border-muted-foreground/25',
    text: '',
    textStyle: { color: 'var(--text-dim)', background: 'color-mix(in oklch, var(--text-dim) 10%, transparent)' },
    pulse: false,
  },
};

/**
 * Inline SVG glyphs — no icon library, stroke="currentColor" so the parent's
 * text color drives hue, and strokeWidth="1.5" matches MemoryFolders.
 *
 *   completed → check
 *   running   → concentric dot (reads as "in progress" and pulses)
 *   failed    → x
 *   cancelled → horizontal bar (dash)
 *   unknown   → question mark
 */
export const STATUS_ICON: Record<StatusKey, JSX.Element> = {
  completed: <polyline points="5 12 10 17 19 7" />,
  running: (
    <>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="8" opacity="0.45" />
    </>
  ),
  failed: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  cancelled: <line x1="6" y1="12" x2="18" y2="12" />,
  unknown: (
    <>
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" />
      <line x1="12" y1="16.5" x2="12" y2="16.5" />
    </>
  ),
};
