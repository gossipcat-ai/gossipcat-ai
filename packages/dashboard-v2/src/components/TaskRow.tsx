import type { JSX } from 'react';
import type { TaskItem } from '@/lib/types';
import { timeAgo, agentColor } from '@/lib/utils';

interface TaskRowProps {
  task: TaskItem;
  onClick?: (task: TaskItem) => void;
}

/**
 * Canonical status buckets the indicator renders. We normalise incoming status
 * strings (including aliases we may receive from older task sources) into one
 * of these five keys so the icon-box treatment stays exhaustive.
 */
type StatusKey = 'completed' | 'running' | 'failed' | 'cancelled' | 'unknown';

/**
 * Normalise a free-form task status into one of our canonical buckets. The
 * TaskItem type currently narrows to four literals, but collect/relay can
 * surface aliases ("done", "error", "in_progress", etc.) — we fold those in
 * rather than letting them fall through to the gray "unknown" fallback.
 */
function normaliseStatus(status: string): StatusKey {
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
const STATUS_META: Record<StatusKey, {
  label: string;
  iconBox: string;   // bg tint + border ring on the 22px square
  text: string;      // icon stroke + label color
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
    iconBox: 'bg-destructive/10 border-destructive/30',
    text: 'text-destructive',
    pulse: false,
  },
  cancelled: {
    label: 'Cancelled',
    iconBox: 'bg-muted-foreground/10 border-muted-foreground/25',
    text: 'text-muted-foreground',
    pulse: false,
  },
  unknown: {
    label: 'Unknown',
    iconBox: 'bg-muted-foreground/10 border-muted-foreground/25',
    text: 'text-muted-foreground',
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
const STATUS_ICON: Record<StatusKey, JSX.Element> = {
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

function formatDurationNice(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return '< 1s';
  if (ms < 60000) return Math.floor(ms / 1000) + 's';
  if (ms < 3600000) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function TaskRow({ task, onClick }: TaskRowProps) {
  const key = normaliseStatus(task.status);
  const meta = STATUS_META[key];

  return (
    <tr
      className={`border-b border-border hover:bg-accent/30 transition-colors ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick ? (e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        onClick(task);
      } : undefined}
    >
      <td className="py-2.5 pl-4 pr-2">
        <span className="inline-flex items-center gap-2" aria-label={`Status: ${meta.label}`}>
          <span
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border ${meta.iconBox} ${meta.text} ${meta.pulse ? 'animate-pulse' : ''}`}
            aria-hidden
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {STATUS_ICON[key]}
            </svg>
          </span>
          <span className={`font-mono text-[10px] font-semibold uppercase tracking-wider ${meta.text}`}>
            {meta.label}
          </span>
        </span>
      </td>
      <td className="py-2.5 pr-3">
        <span className="rounded border border-amber-500/25 bg-amber-500/8 px-2 py-1 font-mono text-[10px] font-semibold text-amber-400">
          {task.taskId.slice(0, 8)}
        </span>
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
        <a href={`/dashboard/agent/${encodeURIComponent(task.agentId)}`} className="inline-flex items-center gap-1.5 transition hover:text-primary">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: agentColor(task.agentId) }} />
          {task.agentId}
        </a>
      </td>
      <td className="py-2.5 pr-3 font-inter text-sm text-foreground/80">
        {(() => { const line = task.task.replace(/\n.*/s, ''); return line.length > 100 ? line.slice(0, 100) + '…' : line; })()}
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
        {key === 'running' ? 'running' : formatDurationNice(task.duration)}
      </td>
      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
        {timeAgo(task.timestamp)}
      </td>
    </tr>
  );
}
