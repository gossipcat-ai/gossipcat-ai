import type { TasksData } from '@/lib/types';
import { timeAgo, taskKindFromAgentId } from '@/lib/utils';
import { normaliseStatus, STATUS_META, STATUS_ICON } from '@/lib/task-status';
import { EmptyState } from './EmptyState';

const DEFAULT_PAGE_SIZE = 8;

interface TasksSectionProps {
  tasks: TasksData;
  limit?: number;
}

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
        <h2 className="h-section">
          Tasks <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{tasks.total}</span>
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
                  className={`mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border ${meta.iconBox} ${meta.text} ${meta.pulse ? 'animate-pulse motion-reduce:animate-none' : ''}`}
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
