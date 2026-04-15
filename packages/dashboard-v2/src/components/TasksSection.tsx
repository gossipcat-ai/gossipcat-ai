import type { JSX } from 'react';
import type { TasksData } from '@/lib/types';
import { timeAgo } from '@/lib/utils';
import { EmptyState } from './EmptyState';

const DEFAULT_PAGE_SIZE = 8;

interface TasksSectionProps {
  tasks: TasksData;
  limit?: number;
}

/**
 * Canonical status buckets — kept in sync with TaskRow.tsx. If you tweak one,
 * tweak the other: these two components are the dashboard's two surface areas
 * for task status and should read as the same visual language.
 */
type StatusKey = 'completed' | 'running' | 'failed' | 'cancelled' | 'unknown';

function normaliseStatus(status: string): StatusKey {
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'done' || s === 'success' || s === 'succeeded') return 'completed';
  if (s === 'running' || s === 'active' || s === 'in_progress' || s === 'pending') return 'running';
  if (s === 'failed' || s === 'error' || s === 'errored' || s === 'timeout' || s === 'timed_out') return 'failed';
  if (s === 'cancelled' || s === 'canceled' || s === 'queued' || s === 'waiting') return 'cancelled';
  return 'unknown';
}

/**
 * Compact variant of the TaskRow icon-box treatment: 18px square so the inline
 * task list stays dense. Same palette + glyph language to keep both surfaces
 * reading as one system.
 */
const STATUS_META: Record<StatusKey, {
  label: string;
  iconBox: string;
  text: string;
  pulse: boolean;
}> = {
  completed: { label: 'Done', iconBox: 'bg-confirmed/10 border-confirmed/30', text: 'text-confirmed', pulse: false },
  running: { label: 'Running', iconBox: 'bg-unverified/10 border-unverified/30', text: 'text-unverified', pulse: true },
  failed: { label: 'Failed', iconBox: 'bg-destructive/10 border-destructive/30', text: 'text-destructive', pulse: false },
  cancelled: { label: 'Cancelled', iconBox: 'bg-muted-foreground/10 border-muted-foreground/25', text: 'text-muted-foreground', pulse: false },
  unknown: { label: 'Unknown', iconBox: 'bg-muted-foreground/10 border-muted-foreground/25', text: 'text-muted-foreground', pulse: false },
};

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

// Short-form task ID: first 8 chars of a UUID (or whatever ID is present).
function shortTaskId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function TasksSection({ tasks, limit = DEFAULT_PAGE_SIZE }: TasksSectionProps) {
  const visible = tasks.items.slice(0, limit);
  const hasMore = tasks.items.length > limit;

  return (
    <section className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Tasks <span className="text-primary">{tasks.total}</span>
        </h2>
        {hasMore && (
          <a href="/dashboard/tasks" className="font-mono text-xs text-muted-foreground transition hover:text-foreground">
            view all
          </a>
        )}
      </div>
      <div className="flex-1 rounded-md border border-border/40 bg-card/80">
        {visible.length === 0 ? (
          <EmptyState
            title="No tasks yet"
            hint="Dispatch with gossip_run to populate this view."
          />
        ) : (
          visible.map((task, i) => {
            const key = normaliseStatus(task.status);
            const meta = STATUS_META[key];
            return (
              <div
                key={task.taskId}
                className={`flex items-start gap-3 px-3.5 py-2.5 hover:bg-accent/20 transition-colors ${i > 0 ? 'border-t border-border/20' : ''}`}
              >
                <span
                  className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border ${meta.iconBox} ${meta.text} ${meta.pulse ? 'animate-pulse' : ''}`}
                  aria-label={`Status: ${meta.label}`}
                  data-tooltip={meta.label}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    {STATUS_ICON[key]}
                  </svg>
                </span>
                <span
                  className="mt-0.5 shrink-0 rounded border border-border/40 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground"
                  data-tooltip={task.taskId}
                >
                  {shortTaskId(task.taskId)}
                </span>
                <span className="min-w-0 flex-1 line-clamp-2 font-inter text-[11px] leading-snug text-muted-foreground">
                  {task.task}
                </span>
                <span className="mt-0.5 shrink-0 font-mono text-xs font-bold text-foreground">{task.agentId}</span>
                <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground/50">{timeAgo(task.timestamp)}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
