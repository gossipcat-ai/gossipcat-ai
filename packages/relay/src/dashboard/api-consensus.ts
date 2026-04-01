import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface ConsensusSignal {
  type: string;
  taskId: string;
  consensusId?: string;
  signal: string;
  agentId: string;
  counterpartId?: string;
  findingId?: string;
  evidence?: string;
  timestamp: string;
}

interface ConsensusRun {
  taskId: string;
  timestamp: string;
  agents: string[];
  signals: { signal: string; agentId: string; counterpartId?: string; findingId?: string; evidence?: string }[];
  counts: { agreement: number; disagreement: number; unverified: number; unique: number; hallucination: number; new: number; insights: number };
}

export interface ConsensusResponse {
  runs: ConsensusRun[];
  totalSignals: number;
}

// Signals that resolve an UNVERIFIED finding
const RESOLUTION_SIGNALS = new Set(['agreement', 'unique_confirmed', 'consensus_verified']);

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

  // Build a set of resolved findingIds — any findingId that has a resolution signal
  const resolvedFindings = new Set<string>();
  for (const sig of signals) {
    if (sig.findingId && RESOLUTION_SIGNALS.has(sig.signal)) {
      resolvedFindings.add(sig.findingId);
    }
  }

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
    const counts = { agreement: 0, disagreement: 0, unverified: 0, unique: 0, hallucination: 0, new: 0, insights: 0 };

    for (const s of taskSignals) {
      agents.add(s.agentId);
      if (s.counterpartId) agents.add(s.counterpartId);

      // Resolve UNVERIFIED signals that have a later resolution for the same findingId
      let effectiveSignal = s.signal;
      if (s.signal === 'unverified' && s.findingId && resolvedFindings.has(s.findingId)) {
        effectiveSignal = 'agreement'; // resolved by orchestrator verification
      }

      if (effectiveSignal === 'agreement') counts.agreement++;
      else if (effectiveSignal === 'disagreement') counts.disagreement++;
      else if (effectiveSignal === 'unverified') counts.unverified++;
      else if (effectiveSignal === 'unique_confirmed' || effectiveSignal === 'unique_unconfirmed') counts.unique++;
      else if (effectiveSignal === 'hallucination_caught') counts.hallucination++;
      else if (effectiveSignal === 'new_finding') counts.new++;
    }

    // Only show real consensus runs (multiple signals from cross-review), not manual recordings
    if (agents.size >= 2 && taskSignals.length >= 3) {
      runs.push({
        taskId,
        timestamp: taskSignals[0].timestamp,
        agents: [...agents].sort(),
        signals: taskSignals.map(s => {
          // Forward findingId and resolve display signal
          let displaySignal = s.signal;
          if (s.signal === 'unverified' && s.findingId && resolvedFindings.has(s.findingId)) {
            displaySignal = 'agreement'; // orchestrator verified
          }
          return {
            signal: displaySignal, agentId: s.agentId,
            counterpartId: s.counterpartId, findingId: s.findingId, evidence: s.evidence,
          };
        }),
        counts,
      });
    }
  }

  // Most recent first
  runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { runs, totalSignals: signals.length };
}
