import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface ConsensusSignal {
  type: string;
  taskId: string;
  consensusId?: string;
  signal: string;
  agentId: string;
  counterpartId?: string;
  evidence?: string;
  timestamp: string;
}

interface ConsensusRun {
  taskId: string;
  timestamp: string;
  agents: string[];
  signals: { signal: string; agentId: string; counterpartId?: string; evidence?: string }[];
  counts: { agreement: number; disagreement: number; unverified: number; unique: number; hallucination: number; new: number };
}

export interface ConsensusResponse {
  runs: ConsensusRun[];
  totalSignals: number;
}

export async function consensusHandler(projectRoot: string): Promise<ConsensusResponse> {
  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (!existsSync(perfPath)) return { runs: [], totalSignals: 0 };

  const signals: ConsensusSignal[] = [];
  try {
    const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'consensus' && parsed.taskId) {
          signals.push(parsed);
        }
      } catch { /* skip malformed */ }
    }
  } catch { return { runs: [], totalSignals: 0 }; }

  // Group by consensusId (falls back to taskId for old signals)
  const byRun = new Map<string, ConsensusSignal[]>();
  for (const sig of signals) {
    const runId = sig.consensusId ?? sig.taskId;
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId)!.push(sig);
  }

  const runs: ConsensusRun[] = [];
  for (const [taskId, taskSignals] of byRun) {
    const agents = new Set<string>();
    const counts = { agreement: 0, disagreement: 0, unverified: 0, unique: 0, hallucination: 0, new: 0 };

    for (const s of taskSignals) {
      agents.add(s.agentId);
      if (s.counterpartId) agents.add(s.counterpartId);
      if (s.signal === 'agreement') counts.agreement++;
      else if (s.signal === 'disagreement') counts.disagreement++;
      else if (s.signal === 'unverified') counts.unverified++;
      else if (s.signal === 'unique_confirmed' || s.signal === 'unique_unconfirmed') counts.unique++;
      else if (s.signal === 'hallucination_caught') counts.hallucination++;
      else if (s.signal === 'new_finding') counts.new++;
    }

    runs.push({
      taskId,
      timestamp: taskSignals[0].timestamp,
      agents: [...agents].sort(),
      signals: taskSignals.map(s => ({
        signal: s.signal, agentId: s.agentId,
        counterpartId: s.counterpartId, evidence: s.evidence,
      })),
      counts,
    });
  }

  // Most recent first
  runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { runs, totalSignals: signals.length };
}
