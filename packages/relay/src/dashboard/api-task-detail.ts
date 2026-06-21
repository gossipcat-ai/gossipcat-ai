import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tasksHandler } from './api-tasks';

/** Reads agent-performance.jsonl + its .1 rotation. */
function readPerfLines(perfPath: string): string[] {
  const out: string[] = [];
  const archive = perfPath + '.1';
  if (existsSync(archive)) {
    out.push(...readFileSync(archive, 'utf-8').split('\n').filter(Boolean));
  }
  if (existsSync(perfPath)) {
    out.push(...readFileSync(perfPath, 'utf-8').split('\n').filter(Boolean));
  }
  return out;
}

/** Reads implementation-findings.jsonl + its .1 rotation. */
function readFindingsLines(findingsPath: string): string[] {
  const out: string[] = [];
  const archive = findingsPath + '.1';
  if (existsSync(archive)) {
    out.push(...readFileSync(archive, 'utf-8').split('\n').filter(Boolean));
  }
  if (existsSync(findingsPath)) {
    out.push(...readFileSync(findingsPath, 'utf-8').split('\n').filter(Boolean));
  }
  return out;
}

export interface TaskDetailResponse {
  taskId: string;
  agentId: string;
  task: string;
  result?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running';
  /** Duration in milliseconds. Sourced from durationMs field in task-graph.jsonl.
   *  Note: the raw event field is "durationMs" on disk; api-tasks.ts reads it
   *  as "entry.duration" which is undefined — this handler reads the correct
   *  "entry.durationMs" field and maps it to "duration" in the response. */
  duration?: number;
  timestamp: string;
  inputTokens?: number;
  outputTokens?: number;
  /** First non-empty consensusId from agent-performance.jsonl rows matching this taskId. */
  consensusId?: string;
  /** Other taskIds that share the same consensusId, capped at 25. */
  siblingTaskIds?: string[];
  /** Count of agent-performance.jsonl rows matching this taskId. */
  signalCount?: number;
  /** Count of implementation-findings.jsonl rows where taskId field matches this taskId. */
  findingCount?: number;
}

/** Cap for sibling task IDs to avoid unbounded response size. */
const SIBLING_CAP = 25;

export async function taskDetailHandler(
  projectRoot: string,
  taskId: string,
): Promise<TaskDetailResponse | null> {
  // Fetch base task from tasksHandler (reuses task-graph parsing logic).
  // Use a large limit to ensure we can find the task even if it's old.
  const all = await tasksHandler(projectRoot, new URLSearchParams({ limit: '2000', offset: '0' }));
  const base = all.items.find((t) => t.taskId === taskId);
  if (!base) return null;

  // Enrich with agent-performance.jsonl
  let consensusId: string | undefined;
  let signalCount = 0;
  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  try {
    const lines = readPerfLines(perfPath);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.taskId !== taskId) continue;
        signalCount++;
        if (!consensusId && typeof entry.consensusId === 'string' && entry.consensusId) {
          consensusId = entry.consensusId;
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* file unreadable — best effort */ }

  // Collect sibling taskIds (other tasks sharing the same consensusId)
  let siblingTaskIds: string[] | undefined;
  if (consensusId) {
    const siblingSet = new Set<string>();
    const perfPath2 = join(projectRoot, '.gossip', 'agent-performance.jsonl');
    try {
      const lines = readPerfLines(perfPath2);
      for (const line of lines) {
        if (siblingSet.size >= SIBLING_CAP) break;
        try {
          const entry = JSON.parse(line);
          if (
            entry.consensusId === consensusId &&
            typeof entry.taskId === 'string' &&
            entry.taskId &&
            entry.taskId !== taskId
          ) {
            siblingSet.add(entry.taskId);
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* best effort */ }
    if (siblingSet.size > 0) {
      siblingTaskIds = [...siblingSet];
    }
  }

  // Count implementation-findings rows for this taskId.
  // Note: the "taskId" field in implementation-findings.jsonl currently stores
  // finding-level IDs (e.g. "consensusId:fN") rather than dispatch task IDs,
  // so this count will typically be 0 until that data schema is unified.
  // We still perform the lookup faithfully per spec.
  let findingCount = 0;
  const findingsPath = join(projectRoot, '.gossip', 'implementation-findings.jsonl');
  try {
    const lines = readFindingsLines(findingsPath);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.taskId === taskId) findingCount++;
      } catch { /* skip malformed */ }
    }
  } catch { /* best effort */ }

  return {
    taskId: base.taskId,
    agentId: base.agentId,
    task: base.task,
    result: base.result,
    status: base.status,
    duration: base.duration,
    timestamp: base.timestamp,
    inputTokens: base.inputTokens,
    outputTokens: base.outputTokens,
    ...(consensusId !== undefined && { consensusId }),
    ...(siblingTaskIds !== undefined && { siblingTaskIds }),
    signalCount,
    findingCount,
  };
}
