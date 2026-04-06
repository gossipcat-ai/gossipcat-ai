import type { TasksData } from '@/lib/types';
import { timeAgo } from '@/lib/utils';

const PAGE_SIZE = 8;

interface TasksSectionProps {
  tasks: TasksData;
}

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-confirmed',
  failed: 'bg-destructive',
  running: 'bg-unverified animate-pulse',
  cancelled: 'bg-muted-foreground',
};

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export function TasksSection({ tasks }: TasksSectionProps) {
  const visible = tasks.items.slice(0, PAGE_SIZE);
  const hasMore = tasks.items.length > PAGE_SIZE;

  return (
    <section className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Tasks <span className="text-primary">{tasks.total}</span>
        </h2>
        {hasMore && (
          <a href="/dashboard/tasks" className="font-mono text-xs text-muted-foreground transition hover:text-primary">
            view all
          </a>
        )}
      </div>
      <div className="flex-1 rounded-md border border-border/40 bg-card/80">
        {visible.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">No tasks yet.</div>
        ) : (
          visible.map((task, i) => (
            <div
              key={task.taskId}
              className={`flex h-11 items-center gap-3 px-3.5 ${i > 0 ? 'border-t border-border/20' : ''}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[task.status] || 'bg-muted'}`} />
              <span className="shrink-0 font-mono text-xs font-bold text-foreground">{task.agentId}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
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
