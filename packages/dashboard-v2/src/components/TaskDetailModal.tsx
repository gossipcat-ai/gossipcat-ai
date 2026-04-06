import { useEffect } from 'react';
import type { TaskItem } from '@/lib/types';
import { timeAgo, formatDuration, cleanFindingTags } from '@/lib/utils';

interface TaskDetailModalProps {
  task: TaskItem | null;
  onClose: () => void;
}

const STATUS_META: Record<TaskItem['status'], { label: string; cls: string }> = {
  completed: { label: 'COMPLETED', cls: 'text-confirmed bg-confirmed/10' },
  failed: { label: 'FAILED', cls: 'text-destructive bg-destructive/10' },
  cancelled: { label: 'CANCELLED', cls: 'text-muted-foreground bg-muted/30' },
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative mt-12 w-full max-w-3xl rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold ${meta.cls}`}>
                {meta.label}
              </span>
              <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-400">
                {task.taskId.slice(0, 8)}
              </span>
              <a
                href={`/dashboard/agent/${encodeURIComponent(task.agentId)}`}
                className="truncate font-mono text-xs text-muted-foreground transition hover:text-primary"
              >
                {task.agentId}
              </a>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
              <span>{timeAgo(task.timestamp)}</span>
              {task.duration != null && <span>· {formatDuration(task.duration)}</span>}
              {totalTokens > 0 && (
                <span>· {totalTokens.toLocaleString()} tokens ({(task.inputTokens || 0).toLocaleString()} in / {(task.outputTokens || 0).toLocaleString()} out)</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md border border-border/40 bg-card px-2 py-1 font-mono text-xs text-muted-foreground transition hover:bg-accent/50 hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[calc(100vh-220px)] space-y-5 overflow-y-auto px-5 py-4">
          {/* Task prompt */}
          <section>
            <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Task
            </h3>
            <pre className="whitespace-pre-wrap rounded-md border border-border/40 bg-background/40 p-3 font-mono text-xs leading-relaxed text-foreground/90">
              {task.task}
            </pre>
          </section>

          {/* Result */}
          {task.result ? (
            <section>
              <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Result
              </h3>
              <div
                className="rounded-md border border-border/40 bg-background/40 p-3 font-mono text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap [&_.cite-file]:rounded [&_.cite-file]:bg-blue-500/10 [&_.cite-file]:px-1 [&_.cite-file]:text-blue-400 [&_.cite-fn]:rounded [&_.cite-fn]:bg-purple-500/10 [&_.cite-fn]:px-1 [&_.cite-fn]:text-purple-400 [&_.inline-code]:rounded [&_.inline-code]:bg-muted/40 [&_.inline-code]:px-1 [&_.inline-code-block]:my-2 [&_.inline-code-block]:block [&_.inline-code-block]:rounded [&_.inline-code-block]:bg-muted/30 [&_.inline-code-block]:p-2"
                dangerouslySetInnerHTML={{ __html: cleanFindingTags(task.result) }}
              />
            </section>
          ) : (
            <section>
              <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Result
              </h3>
              <div className="rounded-md border border-border/40 bg-background/40 p-3 text-center font-mono text-xs text-muted-foreground">
                {task.status === 'running' ? 'Task is still running...' : 'No result recorded.'}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
