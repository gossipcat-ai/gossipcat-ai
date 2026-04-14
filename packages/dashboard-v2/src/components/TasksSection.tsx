import type { TasksData } from '@/lib/types';
import { timeAgo } from '@/lib/utils';
import { EmptyState } from './EmptyState';

const DEFAULT_PAGE_SIZE = 8;

interface TasksSectionProps {
  tasks: TasksData;
  limit?: number;
}

const STATUS_PILL: Record<string, { cls: string; symbol: string }> = {
  completed: { cls: 'bg-confirmed/15 text-confirmed', symbol: '✓' },
  failed: { cls: 'bg-destructive/15 text-destructive', symbol: '✗' },
  running: { cls: 'bg-unverified/15 text-unverified', symbol: '⋯' },
  cancelled: { cls: 'bg-muted/40 text-muted-foreground', symbol: '·' },
};
const STATUS_PILL_DEFAULT = { cls: 'bg-muted/40 text-muted-foreground', symbol: '·' };

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export function TasksSection({ tasks, limit = DEFAULT_PAGE_SIZE }: TasksSectionProps) {
  const visible = tasks.items.slice(0, limit);
  const hasMore = tasks.items.length > limit;

  return (
    <section className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Tasks <span className="text-foreground">{tasks.total}</span>
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
          visible.map((task, i) => (
            <div
              key={task.taskId}
              className={`flex h-11 items-center gap-3 px-3.5 hover:bg-accent/20 transition-colors ${i > 0 ? 'border-t border-border/20' : ''}`}
            >
              {(() => {
                const pill = STATUS_PILL[task.status] || STATUS_PILL_DEFAULT;
                return (
                  <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold ${pill.cls}`}>
                    <span className="h-1 w-1 rounded-full bg-current" />
                    {pill.symbol}
                  </span>
                );
              })()}
              <span className="shrink-0 font-mono text-xs font-bold text-foreground">{task.agentId}</span>
              <span className="min-w-0 flex-1 truncate font-inter text-[11px] text-muted-foreground">
                {truncate(task.task, 50)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">{timeAgo(task.timestamp)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
