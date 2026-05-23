import type { JSX } from 'react';
import type React from 'react';
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
  textStyle?: React.CSSProperties;
  pulse: boolean;
}> = {
  completed: { label: 'Done', iconBox: 'bg-confirmed/10 border-confirmed/30', text: 'text-confirmed', pulse: false },
  running: { label: 'Running', iconBox: 'bg-unverified/10 border-unverified/30', text: 'text-unverified', pulse: true },
  failed: { label: 'Failed', iconBox: 'bg-destructive/10 border-destructive/30', text: 'text-destructive', pulse: false },
  cancelled: { label: 'Cancelled', iconBox: 'border-muted-foreground/25', text: '', textStyle: { color: 'var(--text-dim)', background: 'color-mix(in oklch, var(--text-dim) 10%, transparent)' }, pulse: false },
  unknown: { label: 'Unknown', iconBox: 'border-muted-foreground/25', text: '', textStyle: { color: 'var(--text-dim)', background: 'color-mix(in oklch, var(--text-dim) 10%, transparent)' }, pulse: false },
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

// Derive a visual kind chip from the agentId suffix.
// Returns null for unrecognized suffixes so the chip is omitted entirely.
function taskKindFromAgentId(agentId: string): { label: string; cls: string; clsStyle?: React.CSSProperties } | null {
  if (agentId.endsWith('-implementer')) return { label: 'IMPL', cls: 'text-unique' };
  if (agentId.endsWith('-reviewer'))    return { label: 'REVIEW', cls: 'text-chart' };
  if (agentId.endsWith('-tester'))      return { label: 'TEST', cls: 'text-unique' };
  if (agentId.endsWith('-researcher'))  return { label: 'RESEARCH', cls: '', clsStyle: { color: 'var(--text-dim)' } };
  if (agentId.endsWith('-designer'))    return { label: 'DESIGN', cls: 'text-chart' };
  return null;
}

export function TasksSection({ tasks, limit = DEFAULT_PAGE_SIZE }: TasksSectionProps) {
  const visible = tasks.items.slice(0, limit);
  const hasMore = tasks.items.length > limit;

  return (
    <section className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="h-section">
          Tasks <span style={{ color: 'var(--accent)' }}>{tasks.total}</span>
        </h2>
        {hasMore && (
          <a href="/dashboard/tasks" className="font-mono text-xs transition" style={{ color: 'var(--text-dim)' }}>
            view all
          </a>
        )}
      </div>
      <div className="flex-1 rounded-md border border-border/40" style={{ background: 'color-mix(in oklch, var(--surface-elev) 80%, transparent)' }}>
        {visible.length === 0 ? (
          <EmptyState
            title="No tasks yet"
            hint="Dispatch with gossip_run to populate this view."
          />
        ) : (
          visible.map((task, i) => {
            const key = normaliseStatus(task.status);
            const meta = STATUS_META[key];
            const kind = taskKindFromAgentId(task.agentId);
            return (
              <div
                key={task.taskId}
                className={`flex items-start gap-3 px-3.5 py-2.5 hover:bg-accent/20 transition-colors ${i > 0 ? 'border-t border-border/20' : ''}`}
              >
                <span
                  className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border ${meta.iconBox} ${meta.text} ${meta.pulse ? 'animate-pulse' : ''}`}
                  style={meta.textStyle}
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
                  className="mt-0.5 shrink-0 rounded border border-border/40 px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                  style={{ background: 'color-mix(in oklch, var(--surface) 60%, transparent)', color: 'var(--text-dim)' }}
                  data-tooltip={task.taskId}
                >
                  {shortTaskId(task.taskId)}
                </span>
                {kind && (
                  <span
                    className={`shrink-0 rounded-sm border border-border/40 px-1 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${kind.cls}`}
                    style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)', ...kind.clsStyle }}
                    data-tooltip={task.agentId}
                  >
                    {kind.label}
                  </span>
                )}
                <span className="min-w-0 flex-1 line-clamp-2 font-inter text-[11px] leading-snug" style={{ color: 'var(--text)' }}>
                  {task.task}
                </span>
                <span className="mt-0.5 shrink-0 font-mono text-[10px] font-normal" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>{task.agentId}</span>
                <span className="mt-0.5 shrink-0 font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>{timeAgo(task.timestamp)}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
