import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface TaskEntry {
  taskId: string;
  agentId: string;
  task: string;
  result?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running';
  duration?: number;
  timestamp: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TasksResponse {
  items: TaskEntry[];
  total: number;
  offset: number;
  limit: number;
}

export async function tasksHandler(projectRoot: string, query?: URLSearchParams): Promise<TasksResponse> {
  const rawLimit = parseInt(query?.get('limit') ?? '50', 10);
  const rawOffset = parseInt(query?.get('offset') ?? '0', 10);
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 2000);
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const graphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  if (!existsSync(graphPath)) return { items: [], total: 0, offset, limit };

  const created = new Map<string, { agentId: string; task: string; timestamp: string }>();
  const completed = new Map<string, { duration?: number; timestamp: string; failed: boolean; cancelled?: boolean; inputTokens?: number; outputTokens?: number; result?: string }>();

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
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            result: typeof entry.result === 'string' ? entry.result : undefined,
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
            cancelled: true,
          });
        }
      } catch { /* skip malformed */ }
    }
  } catch { return { items: [], total: 0, offset, limit }; }

  const tasks: TaskEntry[] = [];
  for (const [taskId, info] of created) {
    const result = completed.get(taskId);
    tasks.push({
      taskId,
      agentId: info.agentId,
      task: info.task,
      result: result?.result,
      status: result ? (result.cancelled ? 'cancelled' : result.failed ? 'failed' : 'completed') : 'running',
      duration: result?.duration,
      timestamp: result?.timestamp || info.timestamp,
      inputTokens: result?.inputTokens,
      outputTokens: result?.outputTokens,
    });
  }

  // Most recent first
  tasks.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { items: tasks.slice(offset, offset + limit), total: tasks.length, offset, limit };
}
