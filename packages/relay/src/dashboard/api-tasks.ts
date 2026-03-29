import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface TaskEntry {
  taskId: string;
  agentId: string;
  task: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running';
  duration?: number;
  timestamp: string;
}

export interface TasksResponse {
  tasks: TaskEntry[];
  total: number;
}

export async function tasksHandler(projectRoot: string): Promise<TasksResponse> {
  const graphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  if (!existsSync(graphPath)) return { tasks: [], total: 0 };

  const created = new Map<string, { agentId: string; task: string; timestamp: string }>();
  const completed = new Map<string, { duration?: number; timestamp: string; failed: boolean }>();

  try {
    const lines = readFileSync(graphPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'task.created') {
          created.set(entry.taskId, {
            agentId: entry.agentId || '?',
            task: entry.task || '',
            timestamp: entry.timestamp,
          });
        } else if (entry.type === 'task.completed') {
          completed.set(entry.taskId, {
            duration: entry.duration,
            timestamp: entry.timestamp,
            failed: false,
          });
        } else if (entry.type === 'task.failed') {
          completed.set(entry.taskId, {
            timestamp: entry.timestamp,
            failed: true,
          });
        } else if (entry.type === 'task.cancelled') {
          completed.set(entry.taskId, {
            timestamp: entry.timestamp,
            failed: false,
          });
        }
      } catch { /* skip malformed */ }
    }
  } catch { return { tasks: [], total: 0 }; }

  const tasks: TaskEntry[] = [];
  for (const [taskId, info] of created) {
    const result = completed.get(taskId);
    tasks.push({
      taskId,
      agentId: info.agentId,
      task: info.task.slice(0, 200),
      status: result ? (result.failed ? 'failed' : 'completed') : 'running',
      duration: result?.duration,
      timestamp: result?.timestamp || info.timestamp,
    });
  }

  // Most recent first
  tasks.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { tasks: tasks.slice(0, 100), total: tasks.length };
}
