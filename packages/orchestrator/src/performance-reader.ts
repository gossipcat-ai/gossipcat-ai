/**
 * PerformanceReader — reads agent-performance.jsonl and computes
 * per-agent scores from consensus signals.
 *
 * Closes the feedback loop: consensus signals → agent scores → dispatch preference.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { ConsensusSignal } from './consensus-types';

export interface AgentScore {
  agentId: string;
  accuracy: number;      // 0-1, higher = more accurate findings
  uniqueness: number;    // 0-1, higher = finds things others miss
  reliability: number;   // 0-1, combined score for dispatch weighting
  totalSignals: number;
  agreements: number;
  disagreements: number;
  uniqueFindings: number;
  hallucinations: number;
  consecutiveFailures: number; // circuit breaker: consecutive negative signals at tail
  circuitOpen: boolean;        // true when consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD
  categoryStrengths: Record<string, number>;
}

const CIRCUIT_BREAKER_THRESHOLD = 3; // consecutive failures → open circuit
const NEGATIVE_SIGNALS = new Set(['hallucination_caught', 'disagreement', 'unique_unconfirmed']);

/** Known consensus signal types — used to filter valid signals in computeScores */
const KNOWN_SIGNALS: Record<ConsensusSignal['signal'], true> = {
  agreement: true,
  disagreement: true,
  unverified: true,
  unique_confirmed: true,
  unique_unconfirmed: true,
  new_finding: true,
  hallucination_caught: true,
  category_confirmed: true,
  consensus_verified: true,
  signal_retracted: true,
  severity_miscalibrated: true,
};

const SEVERITY_MULTIPLIER: Record<string, number> = {
  critical: 4,
  high: 2,
  medium: 1,
  low: 1,
};

function getSeverityMultiplier(severity?: string): number {
  return severity ? (SEVERITY_MULTIPLIER[severity] ?? 1) : 1;
}

export class PerformanceReader {
  private readonly filePath: string;
  // Cache: avoid re-reading file on every dispatch call
  private cachedScores: Map<string, AgentScore> | null = null;
  private cachedMtimeMs = 0;

  constructor(projectRoot: string) {
    this.filePath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  }

  /** Read all signals and compute per-agent scores (cached by file mtime) */
  getScores(): Map<string, AgentScore> {
    // Check if file changed since last read
    let mtimeMs = 0;
    try { mtimeMs = statSync(this.filePath).mtimeMs; } catch { /* file doesn't exist */ }
    if (this.cachedScores && mtimeMs === this.cachedMtimeMs) {
      return this.cachedScores;
    }
    const signals = this.readSignals();
    this.cachedScores = this.computeScores(signals);
    this.cachedMtimeMs = mtimeMs;
    return this.cachedScores;
  }

  /** Get score for a specific agent (returns null if no data) */
  getAgentScore(agentId: string): AgentScore | null {
    return this.getScores().get(agentId) ?? null;
  }

  /** Get a reliability multiplier for dispatch weighting (0.3 to 2.0) */
  getDispatchWeight(agentId: string): number {
    const score = this.getAgentScore(agentId);
    if (!score || score.totalSignals < 3) return 1.0; // not enough data, neutral
    if (score.circuitOpen) return 0.3;
    // Confidence increases with signal volume: 3 → ~0.26, 10 → ~0.63, 30 → ~0.95
    const confidence = 1 - Math.exp(-score.totalSignals / 10);
    // Blend reliability toward neutral (0.5) based on confidence
    const adjusted = 0.5 + (score.reliability - 0.5) * confidence;
    return clamp(0.3 + adjusted * 1.7, 0.3, 2.0);
  }

  /** Check if an agent's circuit breaker is open (3+ consecutive failures) */
  isCircuitOpen(agentId: string): boolean {
    const score = this.getAgentScore(agentId);
    return score?.circuitOpen ?? false;
  }

  private readSignals(): ConsensusSignal[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const SIGNAL_EXPIRY_DAYS = 30;
      const expiryMs = Date.now() - SIGNAL_EXPIRY_DAYS * 86400000;

      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const all = lines.map(line => {
        try { return JSON.parse(line) as ConsensusSignal; }
        catch { return null; }
      }).filter((s): s is ConsensusSignal =>
        s !== null && s.type === 'consensus' && typeof s.agentId === 'string' && s.agentId.length > 0
      );

      // Collect retraction keys: agentId + taskId + signalType combos that have been retracted
      const retracted = new Set<string>();
      for (const s of all) {
        if (s.signal === 'signal_retracted') {
          const taskKey = s.taskId || s.timestamp;
          if (s.retractedSignal) {
            // Scoped retraction: only retract the specific signal type
            retracted.add(s.agentId + ':' + taskKey + ':' + s.retractedSignal);
          } else {
            // Legacy/unscoped retraction: retract all signals for this agent+task
            retracted.add(s.agentId + ':' + taskKey + ':*');
          }
        }
      }

      // Filter: exclude expired, retracted, and retraction signals themselves
      return all.filter(s => {
        if (s.signal === 'signal_retracted') return false;
        // Expire old signals — missing/bad timestamps are treated as expired
        const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
        if (!isFinite(ts) || ts === 0 || ts < expiryMs) return false;
        // Skip retracted signals (check both scoped and wildcard keys)
        const taskKey = s.taskId || s.timestamp;
        if (retracted.has(s.agentId + ':' + taskKey + ':' + s.signal)) return false;
        if (retracted.has(s.agentId + ':' + taskKey + ':*')) return false;
        return true;
      });
    } catch {
      return [];
    }
  }

  private computeScores(signals: ConsensusSignal[]): Map<string, AgentScore> {
    const DECAY_HALF_LIFE = 50; // tasks; match CompetencyProfiler

    const TIME_DECAY_HALF_LIFE_DAYS = 7; // scores drift toward neutral after a week of inactivity
    const now = Date.now();

    // Per-agent accumulators for ratio-based scoring
    const acc = new Map<string, {
      weightedCorrect: number;
      weightedTotal: number;
      weightedUnique: number;
      weightedHallucinations: number;
      tasksSeen: Map<string, number>;
      taskCounter: number;
      agreements: number;
      disagreements: number;
      uniqueFindings: number;
      hallucinations: number;
      totalSignals: number;
      lastSignalMs: number;
      categoryStrengths: Record<string, number>;
    }>();

    const ensure = (id: string) => {
      if (!acc.has(id)) acc.set(id, {
        weightedCorrect: 0, weightedTotal: 0,
        weightedUnique: 0, weightedHallucinations: 0,
        tasksSeen: new Map(), taskCounter: 0,
        agreements: 0, disagreements: 0, uniqueFindings: 0, hallucinations: 0,
        totalSignals: 0, lastSignalMs: 0, categoryStrengths: {},
      });
      return acc.get(id)!;
    };

    // Index task order per agent for decay calculation
    // Index both agentId and counterpartId so winners get correct decay
    for (const signal of signals) {
      const taskKey = signal.taskId || signal.timestamp;
      const a = ensure(signal.agentId);
      if (!a.tasksSeen.has(taskKey)) {
        a.tasksSeen.set(taskKey, a.taskCounter++);
      }
      if (signal.counterpartId && signal.counterpartId.length > 0) {
        const c = ensure(signal.counterpartId);
        if (!c.tasksSeen.has(taskKey)) {
          c.tasksSeen.set(taskKey, c.taskCounter++);
        }
      }
    }

    const peerDiversity = this.computePeerDiversity(signals);

    for (const signal of signals) {
      const isKnown = KNOWN_SIGNALS[signal.signal];
      if (!isKnown) continue;

      const a = ensure(signal.agentId);
      a.totalSignals++;

      // Track most recent signal timestamp for time-based decay
      const signalMs = signal.timestamp ? new Date(signal.timestamp).getTime() : 0;
      if (signalMs > a.lastSignalMs) a.lastSignalMs = signalMs;

      const taskKey = signal.taskId || signal.timestamp;
      const taskIndex = a.tasksSeen.get(taskKey) ?? a.taskCounter - 1;
      const tasksSince = a.taskCounter - taskIndex - 1;
      const decay = Math.pow(0.5, tasksSince / DECAY_HALF_LIFE);
      const sevMul = getSeverityMultiplier(signal.severity);

      switch (signal.signal) {
        case 'agreement':
        case 'category_confirmed':
        case 'consensus_verified': {
          const diversityMul = (signal.signal === 'agreement')
            ? (peerDiversity.get(signal.agentId) ?? 1) : 1;
          a.weightedCorrect += sevMul * decay * diversityMul;
          a.weightedTotal += sevMul * decay;
          a.agreements++;
          if (signal.signal === 'category_confirmed' && signal.category) {
            a.categoryStrengths[signal.category] = (a.categoryStrengths[signal.category] ?? 0) + decay * 0.15;
          }
          break;
        }
        case 'disagreement': {
          a.weightedTotal += sevMul * decay;
          a.disagreements++;
          if (signal.counterpartId && signal.counterpartId.length > 0) {
            const winner = ensure(signal.counterpartId);
            const wi = winner.tasksSeen.get(taskKey) ?? winner.taskCounter - 1;
            const wd = Math.pow(0.5, Math.max(0, winner.taskCounter - wi - 1) / DECAY_HALF_LIFE);
            winner.weightedCorrect += sevMul * wd;
            winner.weightedTotal += sevMul * wd;
            if (signalMs > winner.lastSignalMs) winner.lastSignalMs = signalMs;
          }
          break;
        }
        case 'unverified': {
          // Near-neutral cost — "I don't know" is not evidence of incorrectness
          a.weightedTotal += decay * 0.02;
          break;
        }
        case 'unique_confirmed': {
          a.weightedCorrect += sevMul * decay;
          a.weightedTotal += sevMul * decay;
          a.weightedUnique += 0.2 * sevMul * decay;
          a.uniqueFindings++;
          break;
        }
        case 'unique_unconfirmed': {
          a.weightedUnique += 0.05 * decay;
          a.uniqueFindings++;
          break;
        }
        case 'new_finding': {
          a.weightedUnique += 0.15 * decay;
          a.uniqueFindings++;
          break;
        }
        case 'hallucination_caught': {
          const severity = (
            signal.outcome === 'fabricated_citation' ||
            signal.outcome === 'confirmed_hallucination'
          ) ? 3.0 : 1.0;
          a.weightedHallucinations += severity * decay;
          a.weightedTotal += decay;
          a.hallucinations++;
          break;
        }
      }
    }

    // Circuit breaker: count consecutive trailing failures per agent
    const consecutiveFailures = new Map<string, number>();
    // Group signals by agent in order, then count trailing negatives
    const signalsByAgent = new Map<string, ConsensusSignal[]>();
    for (const signal of signals) {
      if (!KNOWN_SIGNALS[signal.signal]) continue;
      if (signal.type !== 'consensus') continue;
      const list = signalsByAgent.get(signal.agentId) || [];
      list.push(signal);
      signalsByAgent.set(signal.agentId, list);
    }
    for (const [agentId, agentSignals] of signalsByAgent) {
      // Sort chronologically so "tail" means most recent
      agentSignals.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      let streak = 0;
      // Walk from newest to oldest — count consecutive negatives at tail
      for (let i = agentSignals.length - 1; i >= 0; i--) {
        if (NEGATIVE_SIGNALS.has(agentSignals[i].signal)) streak++;
        else break;
      }
      consecutiveFailures.set(agentId, streak);
    }

    const scores = new Map<string, AgentScore>();
    for (const [id, a] of acc) {
      // Ratio-based accuracy: correct / total evaluated
      const rawAccuracy = a.weightedTotal > 0
        ? clamp(a.weightedCorrect / a.weightedTotal, 0, 1)
        : 0.5;

      // Logarithmic hallucination penalty — diminishing marginal cost, always recoverable
      // 1 hallu: 0.77, 3 hallu: 0.53, 10 hallu: 0.25, 17 hallu: 0.16
      // Previous exponential (0.80^N) created permanent ceiling: 17 hallu = 0.02 (unrecoverable)
      const hallucinationMultiplier = 1 / (1 + a.weightedHallucinations * 0.3);
      const accuracy = clamp(rawAccuracy * hallucinationMultiplier, 0, 1);

      // Diminishing returns: log scale so early findings matter most but more always helps
      // 1 unique_confirmed (0.2) → 0.5 + 0.18 = 0.68
      // 3 unique_confirmed (0.6) → 0.5 + 0.36 = 0.86
      // 10 unique_confirmed (2.0) → 0.5 + 0.45 = 0.95
      const uniqueness = clamp(0.5 + 0.5 * (1 - Math.exp(-a.weightedUnique * 1.5)), 0, 1);

      // Accuracy dominates (0.8), uniqueness is minor modifier (0.2)
      let reliability = clamp(accuracy * 0.8 + uniqueness * 0.2, 0, 1);

      // Time-based decay: pull reliability toward neutral (0.5) based on inactivity.
      // Good agents (reliability >= 0.5) lose their edge with a 7-day half-life.
      // Bad agents (reliability < 0.5) slowly rehabilitate with a 21-day half-life —
      // slower recovery to avoid reinstating unreliable agents too quickly.
      if (a.lastSignalMs > 0) {
        const daysSinceLastSignal = (now - a.lastSignalMs) / 86400000;
        const halfLife = reliability >= 0.5 ? TIME_DECAY_HALF_LIFE_DAYS : TIME_DECAY_HALF_LIFE_DAYS * 3;
        const timeFreshness = Math.pow(0.5, daysSinceLastSignal / halfLife);
        reliability = 0.5 + (reliability - 0.5) * timeFreshness;
      }

      const consec = consecutiveFailures.get(id) || 0;
      scores.set(id, {
        agentId: id, accuracy, uniqueness, reliability,
        totalSignals: a.totalSignals,
        agreements: a.agreements,
        disagreements: a.disagreements,
        uniqueFindings: a.uniqueFindings,
        hallucinations: a.hallucinations,
        consecutiveFailures: consec,
        circuitOpen: consec >= CIRCUIT_BREAKER_THRESHOLD,
        categoryStrengths: a.categoryStrengths,
      });
    }

    return scores;
  }

  private computePeerDiversity(signals: ConsensusSignal[]): Map<string, number> {
    const SIGNAL_EXPIRY_DAYS = 30;
    const expiryMs = Date.now() - SIGNAL_EXPIRY_DAYS * 86400000;
    const peerSets = new Map<string, Set<string>>();
    const recentAgents = new Set<string>();
    for (const s of signals) {
      const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
      if (ts > expiryMs) recentAgents.add(s.agentId);
      if (s.signal === 'agreement' && s.counterpartId) {
        const peers = peerSets.get(s.agentId) || new Set();
        peers.add(s.counterpartId);
        peerSets.set(s.agentId, peers);
      }
    }
    const result = new Map<string, number>();
    const teamSize = Math.max(recentAgents.size - 1, 1);
    for (const [agentId, peers] of peerSets) {
      result.set(agentId, Math.min(1.5, Math.max(0.3, peers.size / teamSize)));
    }
    return result;
  }

  getImplScore(agentId: string): { passRate: number; peerApproval: number; reliability: number } | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      let pass = 0, fail = 0, approved = 0, rejected = 0;
      for (const line of lines) {
        try {
          const s = JSON.parse(line);
          if (s.type !== 'impl' || s.agentId !== agentId) continue;
          if (s.signal === 'impl_test_pass') pass++;
          if (s.signal === 'impl_test_fail') fail++;
          if (s.signal === 'impl_peer_approved') approved++;
          if (s.signal === 'impl_peer_rejected') rejected++;
        } catch { continue; }
      }
      const total = pass + fail;
      const peerTotal = approved + rejected;
      if (total === 0 && peerTotal === 0) return null;
      const passRate = total > 0 ? pass / total : 0.5;
      const peerApproval = peerTotal > 0 ? approved / peerTotal : 0.5;
      return { passRate, peerApproval, reliability: clamp(passRate * 0.6 + peerApproval * 0.4, 0, 1) };
    } catch { return null; }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
