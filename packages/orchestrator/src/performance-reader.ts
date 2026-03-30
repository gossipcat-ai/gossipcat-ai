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
};

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
    // Circuit breaker: 3+ consecutive failures → minimum weight
    if (score.circuitOpen) return 0.3;
    // Map reliability (0-1) to weight (0.3-2.0): best agent is ~6.7x worst
    return clamp(0.3 + score.reliability * 1.7, 0.3, 2.0);
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

      // Collect retraction keys: agentId + taskId combos that have been retracted
      const retracted = new Set<string>();
      for (const s of all) {
        if (s.signal === 'signal_retracted') {
          retracted.add(s.agentId + ':' + (s.taskId || s.timestamp));
        }
      }

      // Filter: exclude expired, retracted, and retraction signals themselves
      return all.filter(s => {
        if (s.signal === 'signal_retracted') return false;
        // Expire old signals — missing/bad timestamps are treated as expired
        const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
        if (!isFinite(ts) || ts === 0 || ts < expiryMs) return false;
        // Skip retracted signals
        const key = s.agentId + ':' + (s.taskId || s.timestamp);
        if (retracted.has(key)) return false;
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
    }>();

    const ensure = (id: string) => {
      if (!acc.has(id)) acc.set(id, {
        weightedCorrect: 0, weightedTotal: 0,
        weightedUnique: 0, weightedHallucinations: 0,
        tasksSeen: new Map(), taskCounter: 0,
        agreements: 0, disagreements: 0, uniqueFindings: 0, hallucinations: 0,
        totalSignals: 0, lastSignalMs: 0,
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

      switch (signal.signal) {
        case 'agreement':
        case 'category_confirmed':
        case 'consensus_verified': {
          a.weightedCorrect += decay;
          a.weightedTotal += decay;
          a.agreements++;
          break;
        }
        case 'disagreement': {
          a.weightedTotal += decay;
          a.disagreements++;
          if (signal.counterpartId && signal.counterpartId.length > 0) {
            const winner = ensure(signal.counterpartId);
            const wi = winner.tasksSeen.get(taskKey) ?? winner.taskCounter - 1;
            const wd = Math.pow(0.5, Math.max(0, winner.taskCounter - wi - 1) / DECAY_HALF_LIFE);
            winner.weightedCorrect += wd;
            winner.weightedTotal += wd;
            winner.totalSignals++;
          }
          break;
        }
        case 'unverified': {
          // Small denominator cost — couldn't verify, not confirmed wrong
          a.weightedTotal += decay * 0.1;
          break;
        }
        case 'unique_confirmed': {
          a.weightedUnique += 0.2 * decay;
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

      // Multiplicative hallucination penalty — each severity point reduces by 25%
      const hallucinationMultiplier = Math.pow(0.75, a.weightedHallucinations);
      const accuracy = clamp(rawAccuracy * hallucinationMultiplier, 0, 1);

      // Diminishing returns: log scale so early findings matter most but more always helps
      // 1 unique_confirmed (0.2) → 0.5 + 0.18 = 0.68
      // 3 unique_confirmed (0.6) → 0.5 + 0.36 = 0.86
      // 10 unique_confirmed (2.0) → 0.5 + 0.45 = 0.95
      const uniqueness = clamp(0.5 + 0.5 * (1 - Math.exp(-a.weightedUnique * 1.5)), 0, 1);

      // Accuracy dominates (0.8), uniqueness is minor modifier (0.2)
      let reliability = clamp(accuracy * 0.8 + uniqueness * 0.2, 0, 1);

      // Time-based decay: pull reliability toward neutral (0.5) based on inactivity.
      // Only applied to GOOD agents (reliability >= 0.5) — they lose their edge over time.
      // Bad agents (reliability < 0.5) keep their penalty — no free rehab through inactivity.
      if (a.lastSignalMs > 0 && reliability >= 0.5) {
        const daysSinceLastSignal = (now - a.lastSignalMs) / 86400000;
        const timeFreshness = Math.pow(0.5, daysSinceLastSignal / TIME_DECAY_HALF_LIFE_DAYS);
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
      });
    }

    return scores;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
