import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/** Reads a jsonl file + its .1 rotation into an array of raw lines. */
function readJsonlLines(filePath: string): string[] {
  const out: string[] = [];
  const archive = filePath + '.1';
  if (existsSync(archive)) {
    out.push(...readFileSync(archive, 'utf-8').split('\n').filter(Boolean));
  }
  if (existsSync(filePath)) {
    out.push(...readFileSync(filePath, 'utf-8').split('\n').filter(Boolean));
  }
  return out;
}

export interface TaskDetailResponse {
  taskId: string;
  agentId: string;
  task: string;
  result?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running';
  /** Duration in milliseconds sourced from durationMs (preferred) or duration field
   *  in task-graph.jsonl. */
  duration?: number;
  /** ISO timestamp of completion/failure/cancellation event (or dispatch time if running). */
  timestamp: string;
  /** ISO timestamp of task.created event — always the dispatch time. */
  createdAt: string;
  inputTokens?: number;
  outputTokens?: number;
  /** First non-empty consensusId from agent-performance.jsonl rows matching this taskId. */
  consensusId?: string;
  /** Other taskIds that share the same consensusId, capped at SIBLING_CAP. */
  siblingTaskIds?: string[];
  /** True when the sibling list was truncated at SIBLING_CAP. */
  siblingsTruncated?: boolean;
  /** Count of agent-performance.jsonl rows matching this taskId. */
  signalCount?: number;
  /** Count of implementation-findings.jsonl rows whose taskId starts with `${consensusId}:`. */
  findingCount?: number;
}

/** Cap for sibling task IDs to avoid unbounded response size. */
const SIBLING_CAP = 25;

export async function taskDetailHandler(
  projectRoot: string,
  taskId: string,
): Promise<TaskDetailResponse | null> {
  // ── FIX 3: query task-graph.jsonl directly (no 2000-row cap, includes utility-agent tasks) ──
  const graphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  if (!existsSync(graphPath) && !existsSync(graphPath + '.1')) {
    return null;
  }

  const created = new Map<string, { agentId: string; task: string; timestamp: string }>();
  const completed = new Map<string, {
    duration?: number;
    timestamp: string;
    failed: boolean;
    cancelled?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    result?: string;
  }>();

  try {
    const lines = readJsonlLines(graphPath);
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
            duration: entry.durationMs ?? entry.duration,
            timestamp: entry.timestamp,
            failed: false,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            result: typeof entry.result === 'string' ? entry.result : undefined,
          });
        } else if (entry.type === 'task.failed') {
          completed.set(entry.taskId, { timestamp: entry.timestamp, failed: true });
        } else if (entry.type === 'task.cancelled') {
          completed.set(entry.taskId, { timestamp: entry.timestamp, failed: false, cancelled: true });
        }
      } catch { /* skip malformed */ }
    }
  } catch { return null; }

  const info = created.get(taskId);
  if (!info) return null;

  const result = completed.get(taskId);
  const base = {
    taskId,
    agentId: info.agentId,
    task: info.task,
    result: result?.result,
    status: (result
      ? (result.cancelled ? 'cancelled' : result.failed ? 'failed' : 'completed')
      : 'running') as TaskDetailResponse['status'],
    duration: result?.duration,
    timestamp: result?.timestamp || info.timestamp,
    createdAt: info.timestamp,
    inputTokens: result?.inputTokens,
    outputTokens: result?.outputTokens,
  };

  // ── FIX 4: single pass over agent-performance.jsonl for signalCount + consensusId + siblings ──
  let consensusId: string | undefined;
  let signalCount = 0;
  const siblingSet = new Set<string>();

  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  try {
    const lines = readJsonlLines(perfPath);
    // First pass: collect signalCount + consensusId for this taskId.
    // We need consensusId before we can filter siblings, so do two logical passes
    // but only one file read.
    const allEntries: { taskId: string; consensusId?: string }[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry.taskId !== 'string') continue;
        allEntries.push(entry);
        if (entry.taskId === taskId) {
          signalCount++;
          if (!consensusId && typeof entry.consensusId === 'string' && entry.consensusId) {
            consensusId = entry.consensusId;
          }
        }
      } catch { /* skip malformed */ }
    }
    // Second logical pass (same in-memory array) for siblings.
    if (consensusId) {
      for (const entry of allEntries) {
        if (siblingSet.size >= SIBLING_CAP) break;
        if (
          entry.consensusId === consensusId &&
          typeof entry.taskId === 'string' &&
          entry.taskId &&
          entry.taskId !== taskId
        ) {
          siblingSet.add(entry.taskId);
        }
      }
    }
  } catch { /* file unreadable — best effort */ }

  // ── FIX 5: count implementation-findings by consensusId prefix ──
  // implementation-findings.jsonl rows use `taskId` = `${consensusId}:fN` (finding-level IDs).
  // Count rows that START WITH `${consensusId}:` to get round-level finding count.
  let findingCount = 0;
  if (consensusId) {
    const prefix = `${consensusId}:`;
    const findingsPath = join(projectRoot, '.gossip', 'implementation-findings.jsonl');
    try {
      const lines = readJsonlLines(findingsPath);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (typeof entry.taskId === 'string' && entry.taskId.startsWith(prefix)) {
            findingCount++;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* best effort */ }
  }

  const siblingTaskIds = siblingSet.size > 0 ? [...siblingSet] : undefined;
  const siblingsTruncated = siblingSet.size >= SIBLING_CAP;

  return {
    ...base,
    ...(consensusId !== undefined && { consensusId }),
    ...(siblingTaskIds !== undefined && { siblingTaskIds }),
    ...(siblingsTruncated && { siblingsTruncated }),
    signalCount,
    findingCount,
  };
}
