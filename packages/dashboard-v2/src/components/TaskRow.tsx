import type { TaskItem } from '@/lib/types';
import { timeAgo, agentColor, taskKindFromAgentId } from '@/lib/utils';
import { normaliseStatus, STATUS_META, STATUS_ICON } from '@/lib/task-status';
import { navigate } from '@/lib/router';

interface TaskRowProps {
  task: TaskItem;
  onClick?: (task: TaskItem) => void;
}

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
  const kind = taskKindFromAgentId(task.agentId);

  return (
    <tr
      className={`border-b border-border hover:bg-accent/10 transition-colors cursor-pointer`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        // Navigate to the task detail page; also call the legacy setSelected callback
        // so the modal still works until it's fully deprecated.
        onClick?.(task);
        navigate('/tasks/' + task.taskId);
      }}
    >
      <td className="py-2.5 pl-4 pr-2">
        <span className="inline-flex items-center gap-2" aria-label={`Status: ${meta.label}`}>
          <span
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border ${meta.iconBox} ${meta.text} ${meta.pulse ? 'animate-pulse motion-reduce:animate-none' : ''}`}
            style={meta.textStyle}
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
          <span className={`font-mono text-[10px] font-semibold uppercase tracking-wider ${meta.text}`} style={meta.textStyle}>
            {meta.label}
          </span>
        </span>
      </td>
      <td className="py-2.5 pr-3">
        {/* Neutral ID badge — not warn-badge amber (semantic misuse fixed) */}
        <span
          className="rounded border px-2 py-1 font-mono text-[10px] font-semibold"
          style={{
            borderColor: 'color-mix(in oklch, var(--border) 40%, transparent)',
            color: 'var(--ink-3)',
            background: 'color-mix(in oklch, var(--surface) 60%, transparent)',
          }}
          title={task.taskId}
        >
          {task.taskId.slice(0, 8)}
        </span>
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs" style={{ color: 'var(--text-dim)' }}>
        <a href={`/dashboard/agent/${encodeURIComponent(task.agentId)}`} className="inline-flex items-center gap-1.5 transition">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: agentColor(task.agentId) }} />
          {task.agentId}
        </a>
      </td>
      {kind && (
        <td className="py-2.5 pr-3">
          <span
            className={`rounded-sm border border-border/40 px-1 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${kind.cls}`}
            style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)', ...kind.clsStyle }}
          >
            {kind.label}
          </span>
        </td>
      )}
      {!kind && <td className="py-2.5 pr-3" />}
      <td className="py-2.5 pr-3 text-xs leading-snug" style={{ color: 'color-mix(in oklch, var(--text) 80%, transparent)' }}>
        {(() => { const line = task.task.replace(/\n.*/s, ''); return line.length > 100 ? line.slice(0, 100) + '…' : line; })()}
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs" style={{ color: 'var(--text-dim)' }}>
        {key === 'running' ? 'running' : formatDurationNice(task.duration)}
      </td>
      <td className="py-2.5 pr-4 text-right font-mono text-xs" style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>
        {timeAgo(task.timestamp)}
      </td>
    </tr>
  );
}
