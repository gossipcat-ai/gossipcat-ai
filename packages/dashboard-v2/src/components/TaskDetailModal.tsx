import { useEffect } from 'react';
import type React from 'react';
import type { TaskItem } from '@/lib/types';
import { timeAgo, formatDuration, renderFindingMarkdown, renderMarkdown } from '@/lib/utils';

interface TaskDetailModalProps {
  task: TaskItem | null;
  onClose: () => void;
}

const STATUS_META: Record<TaskItem['status'], { label: string; cls: string; clsStyle?: React.CSSProperties }> = {
  completed: { label: 'COMPLETED', cls: 'text-confirmed bg-confirmed/10' },
  failed: { label: 'FAILED', cls: 'text-destructive bg-destructive/10' },
  cancelled: { label: 'CANCELLED', cls: '', clsStyle: { color: 'var(--text-dim)', background: 'color-mix(in oklch, var(--surface-sunk) 30%, transparent)' } },
  running: { label: 'RUNNING', cls: 'text-unverified bg-unverified/10 animate-pulse' },
};

export function TaskDetailModal({ task, onClose }: TaskDetailModalProps) {
  useEffect(() => {
    if (!task) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [task, onClose]);

  if (!task) return null;

  const meta = STATUS_META[task.status];
  const totalTokens = (task.inputTokens || 0) + (task.outputTokens || 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 backdrop-blur-sm"
      style={{ background: 'color-mix(in oklch, var(--surface) 80%, transparent)' }}
      onClick={onClose}
    >
      <div
        className="relative mt-12 w-full max-w-3xl rounded-lg border border-border shadow-2xl"
        style={{ background: 'var(--surface-elev)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold ${meta.cls}`} style={meta.clsStyle}>
                {meta.label}
              </span>
              <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-400">
                {task.taskId.slice(0, 8)}
              </span>
              <a
                href={`/dashboard/agent/${encodeURIComponent(task.agentId)}`}
                className="truncate font-mono text-xs transition"
                style={{ color: 'var(--text-dim)' }}
              >
                {task.agentId}
              </a>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
              <span>{timeAgo(task.timestamp)}</span>
              {task.duration != null && <span>· {formatDuration(task.duration)}</span>}
              {totalTokens > 0 && (
                <span>· {totalTokens.toLocaleString()} tokens ({(task.inputTokens || 0).toLocaleString()} in / {(task.outputTokens || 0).toLocaleString()} out)</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md border border-border/40 px-2 py-1 font-mono text-xs transition hover:bg-accent/50"
            style={{ background: 'var(--surface-elev)', color: 'var(--text-dim)' }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[calc(100vh-220px)] space-y-5 overflow-y-auto px-5 py-4">
          {/* Task prompt — rendered as markdown */}
          <section>
            <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
              Task
            </h3>
            <div
              className="task-md rounded-md border border-border/40 p-3 text-xs leading-relaxed overflow-x-auto"
              style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)', color: 'color-mix(in oklch, var(--text) 90%, transparent)' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(task.task) }}
            />
          </section>

          {/* Result */}
          {task.result ? (
            <section>
              <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
                Result
              </h3>
              <div
                className="finding-md rounded-md border border-border/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [&_.cite-file]:rounded [&_.cite-file]:bg-blue-500/10 [&_.cite-file]:px-1 [&_.cite-file]:text-blue-400 [&_.cite-fn]:rounded [&_.cite-fn]:bg-purple-500/10 [&_.cite-fn]:px-1 [&_.cite-fn]:text-purple-400 [&_.inline-code]:rounded [&_.inline-code]:bg-[color-mix(in_oklch,var(--surface-sunk)_40%,transparent)] [&_.inline-code]:px-1 [&_.inline-code-block]:my-2 [&_.inline-code-block]:block [&_.inline-code-block]:rounded [&_.inline-code-block]:bg-[color-mix(in_oklch,var(--surface-sunk)_30%,transparent)] [&_.inline-code-block]:p-2"
                style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)', color: 'color-mix(in oklch, var(--text) 90%, transparent)' }}
                dangerouslySetInnerHTML={{ __html: renderFindingMarkdown(task.result) }}
              />
            </section>
          ) : (
            <section>
              <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
                Result
              </h3>
              <div className="rounded-md border border-border/40 p-3 text-center font-mono text-xs" style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)', color: 'var(--text-dim)' }}>
                {task.status === 'running' ? 'Task is still running...' : 'No result recorded.'}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
