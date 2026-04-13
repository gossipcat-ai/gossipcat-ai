import type { TaskItem } from '@/lib/types';
import { timeAgo, agentColor } from '@/lib/utils';

interface TaskRowProps {
  task: TaskItem;
  onClick?: (task: TaskItem) => void;
}

const STATUS_PILL: Record<string, { cls: string; label: string }> = {
  completed: { cls: 'text-confirmed bg-confirmed/8', label: 'Done' },
  failed: { cls: 'text-destructive bg-destructive/8', label: 'Failed' },
  running: { cls: 'text-unverified bg-unverified/8', label: 'Running' },
  cancelled: { cls: 'text-muted-foreground bg-muted/50', label: 'Cancelled' },
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
  const pill = STATUS_PILL[task.status] ?? STATUS_PILL.cancelled;
  const dotColor = task.status === 'completed' ? 'bg-confirmed'
    : task.status === 'failed' ? 'bg-destructive'
    : task.status === 'running' ? 'bg-unverified'
    : 'bg-muted-foreground/40';

  return (
    <tr
      className={`border-b border-border hover:bg-accent/30 transition-colors ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick ? (e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        onClick(task);
      } : undefined}
    >
      <td className="py-2.5 pl-4 pr-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold ${pill.cls}`}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
          {pill.label}
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
        {task.status === 'running' ? 'running' : formatDurationNice(task.duration)}
      </td>
      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
        {timeAgo(task.timestamp)}
      </td>
    </tr>
  );
}
