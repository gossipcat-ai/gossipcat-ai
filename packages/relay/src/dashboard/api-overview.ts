import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface AgentConfigLike {
  id: string;
  native?: boolean;
}

interface OverviewContext {
  agentConfigs: AgentConfigLike[];
  relayConnections: number;
  connectedAgentIds: string[];
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
  lastConsensusTimestamp: string;
  actionableFindings: number;
  /** Task counts for each of the last 12 hours (index 0 = 12h ago, index 11 = current hour). */
  hourlyActivity: number[];
}

export async function overviewHandler(projectRoot: string, ctx: OverviewContext): Promise<OverviewResponse> {
  const nativeCount = ctx.agentConfigs.filter(a => a.native).length;
  const relayConnected = ctx.connectedAgentIds.length;
  const relayCount = ctx.agentConfigs.filter(a => !a.native).length;

  // "Online" = agents currently executing tasks.
  // Relay agents: counted only if they have an in-flight task (connected + idle is not "online" for monitoring purposes).
  // Native agents: counted if they have an active dispatch in task-graph.jsonl without a completion event.
  // Cutoff: tasks older than 30 minutes are stale and ignored.
  const activeAgentIds = new Set<string>();
  const STALE_MS = 30 * 60 * 1000;
  let tasksCompleted = 0;
  let tasksFailed = 0;
  let totalDuration = 0;
  let durationCount = 0;
  const hourlyActivity = new Array(12).fill(0);
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;

  // Single pass over task-graph.jsonl for active agents, task stats, and hourly buckets.
  const graphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  if (existsSync(graphPath)) {
    try {
      const created = new Map<string, { agentId: string; timestamp: string }>();
      const finished = new Set<string>();
      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'task.created') {
            if (ev.taskId && ev.agentId) {
              created.set(ev.taskId, { agentId: ev.agentId, timestamp: ev.timestamp || '' });
            }
            // Hourly activity buckets (index 0 = 12h ago, index 11 = current hour)
            if (ev.timestamp) {
              const ts = new Date(ev.timestamp).getTime();
              if (Number.isFinite(ts)) {
                const ageMs = now - ts;
                if (ageMs >= 0 && ageMs < 12 * hourMs) {
                  const idx = 11 - Math.floor(ageMs / hourMs);
                  if (idx >= 0 && idx < 12) hourlyActivity[idx]++;
                }
              }
            }
          } else if (ev.type === 'task.completed') {
            if (ev.taskId) finished.add(ev.taskId);
            tasksCompleted++;
            // Exclude durations exceeding 4 hours — anything longer indicates a fake/guessed
            // dispatched_at_ms. Real tasks top out around ~4h for the slowest consensus rounds;
            // the prior 30d clamp was defense-in-depth but left legacy bogus rows (181-365 days
            // from synthesized timestamps pre-PR #88) free to skew avgDurationMs into the hours.
            const MAX_VALID_DURATION_MS = 4 * 60 * 60 * 1000;
            if (typeof ev.duration === 'number' && ev.duration > 0 && ev.duration <= MAX_VALID_DURATION_MS) {
              totalDuration += ev.duration;
              durationCount++;
            }
          } else if (ev.type === 'task.failed') {
            if (ev.taskId) finished.add(ev.taskId);
            tasksFailed++;
          } else if (ev.type === 'task.cancelled') {
            if (ev.taskId) finished.add(ev.taskId);
          }
        } catch { /* skip */ }
      }
      for (const [taskId, info] of created) {
        if (finished.has(taskId)) continue;
        const ts = info.timestamp ? new Date(info.timestamp).getTime() : NaN;
        if (isNaN(ts) || now - ts > STALE_MS) continue;
        activeAgentIds.add(info.agentId);
      }
    } catch { /* empty */ }
  }

  const agentsOnline = activeAgentIds.size;

  let totalSignals = 0;
  let consensusRuns = 0;
  let totalFindings = 0;
  let confirmedFindings = 0;
  let lastConsensusTimestamp = '';
  let actionableFindings = 0;
  // Per-run buckets for the consensus-runs count: mirror api-consensus.ts:98's
  // "real consensus run" definition (≥2 agents, ≥3 signals). Without this filter,
  // SystemPulse.consensusRuns counts manual/singleton signal recordings and
  // diverges from the Debates page which uses the filtered definition.
  interface RunBucket { agents: Set<string>; signalCount: number; }
  const runBuckets = new Map<string, RunBucket>();

  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (existsSync(perfPath)) {
    try {
      const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // totalSignals counts only real consensus signals — impl_*, signal_retracted,
          // consensus_round_retracted tombstones, and future metadata rows are not
          // "signals" for this counter. Also drop `_system` sentinel rows at the
          // data layer (round tombstones use agentId='_system').
          if (
            entry.type === 'consensus'
            && typeof entry.signal === 'string'
            && entry.signal !== 'signal_retracted'
            && entry.signal !== 'consensus_round_retracted'
            && entry.agentId !== '_system'
          ) {
            totalSignals++;
          }
          // Skip round-retraction tombstones from per-run aggregation.
          if (entry.signal === 'consensus_round_retracted' || entry.agentId === '_system') {
            continue;
          }
          if (entry.type === 'consensus' && (entry.consensusId || entry.taskId)) {
            const runId = entry.consensusId ?? entry.taskId;
            let bucket = runBuckets.get(runId);
            if (!bucket) {
              bucket = { agents: new Set(), signalCount: 0 };
              runBuckets.set(runId, bucket);
            }
            bucket.signalCount++;
            if (entry.agentId) bucket.agents.add(entry.agentId);
            if (entry.counterpartId) bucket.agents.add(entry.counterpartId);
          }
          if (entry.consensusId && entry.timestamp > lastConsensusTimestamp) {
            lastConsensusTimestamp = entry.timestamp;
          }
          if (entry.signal === 'agreement' || entry.signal === 'unique_confirmed' || entry.signal === 'consensus_verified') {
            totalFindings++;
            confirmedFindings++;
          } else if (entry.signal === 'disagreement' || entry.signal === 'hallucination_caught') {
            totalFindings++;
            actionableFindings++;
          } else if (entry.signal === 'new_finding') {
            totalFindings++;
            actionableFindings++;
          } else if (entry.signal === 'unverified' || entry.signal === 'unique_unconfirmed') {
            totalFindings++;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* empty */ }
  }
  // Only count runs with ≥2 agents AND ≥3 signals — matches api-consensus.ts:98.
  for (const bucket of runBuckets.values()) {
    if (bucket.agents.size >= 2 && bucket.signalCount >= 3) consensusRuns++;
  }

  const avgDurationMs = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;

  return { agentsOnline, relayCount, relayConnected, nativeCount, consensusRuns, totalFindings, confirmedFindings, totalSignals, tasksCompleted, tasksFailed, avgDurationMs, lastConsensusTimestamp, actionableFindings, hourlyActivity };
}
