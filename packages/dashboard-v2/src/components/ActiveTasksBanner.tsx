import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

interface ActiveTask {
  taskId: string;
  agentId: string;
  task: string;
  startedAt: string;
}

interface ActiveTasksResponse {
  tasks: ActiveTask[];
}

const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

function elapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return '0s';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

export function ActiveTasksBanner({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [tasks, setTasks] = useState<ActiveTask[]>([]);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchTasks = async () => {
      try {
        const data = await api<ActiveTasksResponse>('active-tasks');
        if (!cancelled) {
          setTasks(data.tasks || []);
          onCountChange?.(data.tasks?.length || 0);
        }
      } catch { /* ignore */ }
    };
    fetchTasks();
    const interval = setInterval(fetchTasks, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [onCountChange]);

  useEffect(() => {
    if (tasks.length === 0) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [tasks.length]);

  const now = Date.now();
  const live = tasks.filter(t => now - new Date(t.startedAt).getTime() < STALE_MS);
  const staleCount = tasks.length - live.length;

  if (live.length === 0) return null;

  // Compact single-row for ≤3 tasks, stacked for more
  if (live.length <= 3) {
    return (
      <div className="flex items-center gap-4 overflow-x-auto rounded-lg border border-unverified/20 bg-unverified/5 px-4 py-2">
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs font-bold text-unverified">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-unverified" />
          {live.length} active
          {staleCount > 0 && (
            <span className="ml-1 font-normal text-muted-foreground/50">+ {staleCount} stale</span>
          )}
        </span>
        <div className="flex min-w-0 flex-1 gap-6">
          {live.map((t) => (
            <div key={t.taskId} className="flex min-w-0 shrink-0 items-center gap-2">
              <span className="font-mono text-[11px] font-semibold text-foreground">{t.agentId}</span>
              <span className="max-w-[280px] truncate text-[11px] text-muted-foreground">{t.task}</span>
              <span className="font-mono text-[11px] text-unverified">{elapsed(t.startedAt)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Stacked layout for 4+ tasks, max-height with scroll
  return (
    <div className="rounded-lg border border-unverified/20 bg-unverified/5 px-4 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-unverified" />
        <span className="font-mono text-xs font-bold text-unverified">
          {live.length} ACTIVE
        </span>
        {staleCount > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/50">+ {staleCount} stale</span>
        )}
      </div>
      <div className="max-h-32 space-y-0.5 overflow-y-auto">
        {live.map((t) => (
          <div key={t.taskId} className="flex items-center gap-3">
            <span className="shrink-0 font-mono text-[11px] font-semibold text-foreground">{t.agentId}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{t.task}</span>
            <span className="shrink-0 font-mono text-[11px] text-unverified">{elapsed(t.startedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
