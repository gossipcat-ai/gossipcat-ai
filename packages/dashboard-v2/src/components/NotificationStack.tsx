import { useState, useCallback, useEffect, useRef } from 'react';
import { useEventStream } from '@/lib/useEventStream';
import { navigate } from '@/lib/router';
import type { DashboardEvent } from '@/lib/useEventStream';

interface Toast {
  id: number;
  event: DashboardEvent;
  exiting: boolean;
}

const MAX_VISIBLE = 5;
const AUTO_DISMISS_MS = 6000;

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
  }, [toast.id, onDismiss, clearTimer]);

  // Start auto-dismiss on mount; clear on unmount (3a)
  useEffect(() => {
    startTimer();
    return clearTimer;
  }, [startTimer, clearTimer]);

  const { type, payload } = toast.event;

  const icon =
    type === 'task.completed'
      ? <span className="text-muted-foreground">✓</span>
      : (payload.confirmed as number) > (payload.disputed as number)
        ? <span className="text-confirmed">◎</span>
        : <span className="text-disputed">◎</span>;

  let body: string;
  if (type === 'task.completed') {
    const agentId = String(payload.agentId ?? 'agent');
    const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : null;
    const durationSec = durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : '—';
    body = `${agentId} finished in ${durationSec}`;
  } else {
    const confirmed = Number(payload.confirmed ?? 0);
    const disputed = Number(payload.disputed ?? 0);
    body = `Consensus done — ${confirmed} confirmed · ${disputed} disputed`;
  }

  const handleClick = () => {
    clearTimer();
    if (type === 'task.completed' && payload.taskId) {
      navigate(`/tasks`);
    } else if (type === 'consensus.completed' && payload.consensusId) {
      navigate(`/debates`);
    }
    onDismiss(toast.id);
  };

  return (
    <div
      className={[
        'pointer-events-auto bg-card border rounded shadow-sm px-4 py-3 max-w-sm cursor-pointer',
        'transition-all duration-200',
        'motion-reduce:transition-none motion-reduce:transform-none',
        'hover:bg-muted/30 hover:border-border',
        toast.exiting
          ? 'opacity-0 scale-95 opacity-0 translate-y-2'
          : 'opacity-100 scale-100 translate-x-0',
      ].join(' ')}
      onClick={handleClick}
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-sm font-bold">{icon}</span>
        <span title={body} className="font-mono text-[11px] text-foreground min-w-0 truncate">{body}</span>
        <button
          className="ml-auto shrink-0 text-muted-foreground/50 hover:text-muted-foreground text-xs leading-none"
          onClick={(e) => { e.stopPropagation(); clearTimer(); onDismiss(toast.id); }}
          aria-label="Dismiss notification"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function NotificationStack() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    // Mark as exiting to trigger exit animation, then remove
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 250);
  }, []);

  const onEvent = useCallback((event: DashboardEvent) => {
    setToasts((prev) => {
      const newToast: Toast = { id: event.id, event, exiting: false };
      const next = [...prev, newToast];
      // Cap at MAX_VISIBLE — dismiss oldest if over limit
      if (next.length > MAX_VISIBLE) {
        const excess = next.length - MAX_VISIBLE;
        return next.slice(excess);
      }
      return next;
    });
  }, []);

  useEventStream(onEvent);

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 pointer-events-none"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );
}
