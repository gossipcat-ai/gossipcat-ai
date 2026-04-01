import type { TaskItem } from '@/lib/types';
import { timeAgo, formatDuration, agentColor } from '@/lib/utils';

interface TaskRowProps {
  task: TaskItem;
}

const STATUS_STYLES = {
  completed: { dot: 'bg-confirmed', label: '●' },
  failed: { dot: 'bg-destructive', label: '✕' },
  running: { dot: 'bg-unverified animate-pulse', label: '◌' },
  cancelled: { dot: 'bg-muted-foreground/40', label: '—' },
} as const;

export function TaskRow({ task }: TaskRowProps) {
  const status = STATUS_STYLES[task.status] ?? STATUS_STYLES.cancelled;
  const color = agentColor(task.agentId);

  return (
    <tr className="border-b border-border transition hover:bg-accent/50">
      <td className="py-2.5 pl-4 pr-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${status.dot}`} />
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
        {task.taskId.slice(0, 8)}
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs font-medium" style={{ color }}>
        {task.agentId}
      </td>
      <td className="max-w-md truncate py-2.5 pr-3 text-sm text-foreground/80">
        {task.task.replace(/\n.*/s, '').slice(0, 80)}
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
        {task.status === 'running' ? 'running' : formatDuration(task.duration)}
      </td>
      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
        {timeAgo(task.timestamp)}
      </td>
    </tr>
  );
}
