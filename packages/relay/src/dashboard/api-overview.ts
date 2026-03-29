import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface AgentConfigLike {
  id: string;
  native?: boolean;
}

interface OverviewContext {
  agentConfigs: AgentConfigLike[];
  relayConnections: number;
}

export interface OverviewResponse {
  agentsOnline: number;
  relayCount: number;
  relayConnected: number;
  nativeCount: number;
  consensusRuns: number;
  totalFindings: number;
  confirmedFindings: number;
  totalSignals: number;
  tasksCompleted: number;
  tasksFailed: number;
  avgDurationMs: number;
}

export async function overviewHandler(projectRoot: string, ctx: OverviewContext): Promise<OverviewResponse> {
  const nativeCount = ctx.agentConfigs.filter(a => a.native).length;
  const relayConnected = ctx.relayConnections;
  const relayCount = ctx.agentConfigs.filter(a => !a.native).length;
  const agentsOnline = ctx.agentConfigs.length;

  let totalSignals = 0;
  let consensusRuns = 0;
  let totalFindings = 0;
  let confirmedFindings = 0;
  const consensusTaskIds = new Set<string>();

  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (existsSync(perfPath)) {
    try {
      const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          totalSignals++;
          // Count consensus runs from unique taskIds in consensus signals
          if (entry.type === 'consensus' && entry.taskId) {
            consensusTaskIds.add(entry.taskId);
          }
          // Count findings by signal type
          if (entry.signal === 'agreement' || entry.signal === 'unique_confirmed' || entry.signal === 'consensus_verified') {
            totalFindings++;
            confirmedFindings++;
          } else if (entry.signal === 'disagreement' || entry.signal === 'hallucination_caught') {
            totalFindings++;
          } else if (entry.signal === 'unverified' || entry.signal === 'unique_unconfirmed') {
            totalFindings++;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* empty */ }
  }
  consensusRuns = consensusTaskIds.size;

  // Task metrics from task-graph.jsonl
  let tasksCompleted = 0;
  let tasksFailed = 0;
  let totalDuration = 0;
  let durationCount = 0;

  const graphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  if (existsSync(graphPath)) {
    try {
      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'task.completed') {
            tasksCompleted++;
            if (typeof entry.duration === 'number' && entry.duration > 0) {
              totalDuration += entry.duration;
              durationCount++;
            }
          } else if (entry.type === 'task.failed') {
            tasksFailed++;
          }
        } catch { /* skip */ }
      }
    } catch { /* empty */ }
  }
  const avgDurationMs = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;

  return { agentsOnline, relayCount, relayConnected, nativeCount, consensusRuns, totalFindings, confirmedFindings, totalSignals, tasksCompleted, tasksFailed, avgDurationMs };
}
