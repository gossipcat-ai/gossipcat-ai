import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { isUtilityAgent } from './utility-agents';

interface ActiveTask {
  taskId: string;
  agentId: string;
  task: string;
  startedAt: string;
}

export interface ActiveTasksResponse {
  tasks: ActiveTask[];
}

export async function activeTasksHandler(projectRoot: string): Promise<ActiveTasksResponse> {
  const taskGraphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  if (!existsSync(taskGraphPath)) return { tasks: [] };

  const created = new Map<string, { agentId: string; task: string; timestamp: string }>();
  const finished = new Set<string>();

  try {
    const lines = readFileSync(taskGraphPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'task.created' && ev.taskId) {
          if (isUtilityAgent(ev.agentId)) continue;
          created.set(ev.taskId, { agentId: ev.agentId || '', task: ev.task || '', timestamp: ev.timestamp || '' });
        } else if (ev.type === 'task.completed' || ev.type === 'task.failed' || ev.type === 'task.cancelled') {
          finished.add(ev.taskId);
        }
      } catch {}
    }
  } catch { return { tasks: [] }; }

  // Tasks older than 30 minutes are assumed dead (no completion event received)
  const STALE_MS = 30 * 60 * 1000;
  const now = Date.now();

  const active: ActiveTask[] = [];
  for (const [taskId, info] of created) {
    if (finished.has(taskId)) continue;
    const ts = info.timestamp ? new Date(info.timestamp).getTime() : NaN;
    if (isNaN(ts) || now - ts > STALE_MS) continue;
    active.push({ taskId, agentId: info.agentId, task: info.task, startedAt: info.timestamp });
  }

  active.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { tasks: active.slice(0, 10) };
}
