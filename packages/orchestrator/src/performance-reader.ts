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
  impactScore: number;   // 0-1, weighted toward agents catching CRITICAL/HIGH findings
  totalSignals: number;
  agreements: number;
  disagreements: number;
  uniqueFindings: number;
  hallucinations: number;
  consecutiveFailures: number; // circuit breaker: consecutive negative signals at tail
  circuitOpen: boolean;        // true when consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD
  categoryStrengths: Record<string, number>;
  categoryCorrect: Record<string, number>;
  categoryHallucinated: Record<string, number>;
  categoryAccuracy: Record<string, number>;
}

export interface CategoryCounters {
  correct: number;
  hallucinated: number;
}

const CIRCUIT_BREAKER_THRESHOLD = 3; // consecutive failures → open circuit
const NEGATIVE_SIGNALS = new Set(['hallucination_caught', 'disagreement', 'unique_unconfirmed']);
const SIGNAL_EXPIRY_DAYS = 30;

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
    const consensusAdjusted = 0.5 + (score.reliability - 0.5) * confidence;
    return clamp(0.3 + consensusAdjusted * 1.7, 0.3, 2.0);
  }

  /** Separate dispatch weight for implementation tasks (0.3 to 2.0). Uses impl signals only. */
  getImplDispatchWeight(agentId: string): number {
    const impl = this.getImplScore(agentId);
    if (!impl) return 1.0; // no impl data, neutral
    return clamp(0.3 + impl.reliability * 1.7, 0.3, 2.0);
  }

  /** Check if an agent's circuit breaker is open (3+ consecutive failures) */
  isCircuitOpen(agentId: string): boolean {
    const score = this.getAgentScore(agentId);
    return score?.circuitOpen ?? false;
  }

  /**
   * Returns count of (correct, hallucinated) signals for an agent in a given
   * category, where signal timestamp >= sinceMs.
   *
   * Uses readSignalsRaw() (no 30d expiry) on purpose: effectiveness checks
   * are a *strategic* long-term metric — has this skill been useful over its
   * entire lifetime? — while dispatch weight (getScores → readSignals) is a
   * *tactical* short-term metric. Different windows by design. Per consensus
   * 9369ebfc-a3654b51 finding 1, this asymmetry is intentional and should
   * not be unified. See readSignalsRaw doc.
   */
  getCountersSince(agentId: string, category: string, sinceMs: number): CategoryCounters {
    const allSignals = this.readSignalsRaw();
    const counters: CategoryCounters = { correct: 0, hallucinated: 0 };

    for (const s of allSignals) {
      if (s.agentId !== agentId) continue;
      if (s.category !== category) continue;
      const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
      if (!isFinite(ts) || ts === 0 || ts < sinceMs) continue;

      switch (s.signal) {
        case 'agreement':
        case 'category_confirmed':
        case 'consensus_verified':
        case 'unique_confirmed':
          counters.correct++;
          break;
        case 'disagreement':
        case 'hallucination_caught':
          counters.hallucinated++;
          break;
      }
    }
    return counters;
  }

  /**
   * Reads all consensus signals without applying the 30-day expiry that
   * readSignals() uses. Intentionally distinct from readSignals: effectiveness
   * scoring needs lifetime history, dispatch weight needs the recent window.
   * Don't unify these — see getCountersSince doc and consensus 9369ebfc-a3654b51 f1.
   */
  private readSignalsRaw(): ConsensusSignal[] {
    if (!existsSync(this.filePath)) return [];
    try {
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

      // Filter: exclude retracted signals and the retraction signals themselves
      return all.filter(s => {
        if (s.signal === 'signal_retracted') return false;
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

  private readSignals(): ConsensusSignal[] {
    if (!existsSync(this.filePath)) return [];
    try {
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
    const DECAY_HALF_LIFE = 50; // tasks

    const TIME_DECAY_HALF_LIFE_DAYS = 7; // scores drift toward neutral after a week of inactivity
    const now = Date.now();

    // Per-agent accumulators for ratio-based scoring
    const acc = new Map<string, {
      weightedCorrect: number;
      weightedTotal: number;
      weightedUnique: number;
      weightedHallucinations: number;
      weightedImpact: number;   // severity-weighted confirmed findings (CRITICAL=4x, HIGH=2x)
      weightedConfirmedCount: number; // decay-weighted count of confirmed signals (denominator for impactScore)
      tasksSeen: Map<string, number>;
      taskCounter: number;
      agreements: number;
      disagreements: number;
      uniqueFindings: number;
      hallucinations: number;
      totalSignals: number;
      lastSignalMs: number;
      categoryStrengths: Record<string, number>;
      categoryCorrect: Record<string, number>;
      categoryHallucinated: Record<string, number>;
    }>();

    const ensure = (id: string) => {
      if (!acc.has(id)) acc.set(id, {
        weightedCorrect: 0, weightedTotal: 0,
        weightedUnique: 0, weightedHallucinations: 0,
        weightedImpact: 0, weightedConfirmedCount: 0,
        tasksSeen: new Map(), taskCounter: 0,
        agreements: 0, disagreements: 0, uniqueFindings: 0, hallucinations: 0,
        totalSignals: 0, lastSignalMs: 0, categoryStrengths: {},
        categoryCorrect: {}, categoryHallucinated: {},
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

    // Build per-agent retraction index so computeScores skips retracted signals
    // even when called with a raw (unfiltered) signal array (e.g. directly from tests).
    const retractedKeys = new Set<string>();
    for (const signal of signals) {
      if (signal.signal === 'signal_retracted') {
        const taskKey = signal.taskId || signal.timestamp;
        if (signal.retractedSignal) {
          retractedKeys.add(signal.agentId + ':' + taskKey + ':' + signal.retractedSignal);
        } else {
          retractedKeys.add(signal.agentId + ':' + taskKey + ':*');
        }
      }
    }

    for (const signal of signals) {
      const isKnown = KNOWN_SIGNALS[signal.signal];
      if (!isKnown) continue;
      if (signal.signal === 'signal_retracted') continue;

      // Skip signals retracted by a signal_retracted entry
      const taskKey2 = signal.taskId || signal.timestamp;
      if (
        retractedKeys.has(signal.agentId + ':' + taskKey2 + ':' + signal.signal) ||
        retractedKeys.has(signal.agentId + ':' + taskKey2 + ':*')
      ) continue;

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
          a.weightedImpact += sevMul * decay;
          a.weightedConfirmedCount += decay;
          if (signal.category) {
            a.categoryStrengths[signal.category] = (a.categoryStrengths[signal.category] ?? 0) + sevMul * decay * 0.15;
            a.categoryCorrect[signal.category] = (a.categoryCorrect[signal.category] ?? 0) + 1;
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
          if (signal.category) {
            a.categoryHallucinated[signal.category] = (a.categoryHallucinated[signal.category] ?? 0) + 1;
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
          a.weightedImpact += sevMul * decay;
          a.weightedConfirmedCount += decay;
          if (signal.category) {
            a.categoryCorrect[signal.category] = (a.categoryCorrect[signal.category] ?? 0) + 1;
          }
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
          if (signal.category) {
            a.categoryHallucinated[signal.category] = (a.categoryHallucinated[signal.category] ?? 0) + 1;
          }
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
      // Sort chronologically so "tail" means most recent.
      // Tiebreaker on consensusId keeps order deterministic when timestamps collide
      // (legacy bulk-recorded data, or signals from the same consensus round).
      agentSignals.sort((a, b) => {
        const t = (a.timestamp || '').localeCompare(b.timestamp || '');
        if (t !== 0) return t;
        return ((a as any).consensusId || '').localeCompare((b as any).consensusId || '');
      });
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

      // Ratio-based uniqueness: unique findings / (unique + agreements).
      // Differentiates agents who find novel issues vs those who only confirm others.
      // Confidence-gated: blends toward 0.5 with sparse data (< 10 relevant signals).
      // sonnet (149u/59a) → 0.72, haiku (96u/62a) → 0.61, gemini (33u/70a) → 0.32
      const uniqueTotal = a.uniqueFindings + a.agreements;
      const rawUniqueness = uniqueTotal > 0 ? a.uniqueFindings / uniqueTotal : 0.5;
      const uniqueConfidence = 1 - Math.exp(-uniqueTotal / 10);
      const uniqueness = clamp(0.5 + (rawUniqueness - 0.5) * uniqueConfidence, 0, 1);

      // Impact score: ratio of severity-weighted confirmed findings to confirmed count.
      // Agent catching only LOW findings → ~0.25. Agent catching CRITICAL → ~1.0.
      // Neutral (0.5) when no data. Confidence-gated to avoid overweighting sparse data.
      const rawImpact = a.weightedConfirmedCount > 0
        ? clamp(a.weightedImpact / a.weightedConfirmedCount, 0, 4) / 4  // max sevMul=4 → normalize to [0,1]
        : 0.5;
      const impactConfidence = 1 - Math.exp(-a.weightedConfirmedCount / 10);
      const impactScore = clamp(0.5 + (rawImpact - 0.5) * impactConfidence, 0, 1);

      // Accuracy dominates (0.75), uniqueness minor (0.15), impact breaks ties (0.10)
      let reliability = clamp(accuracy * 0.75 + uniqueness * 0.15 + impactScore * 0.10, 0, 1);

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

      // Per-category raw accuracy: correct / (correct + hallucinated).
      //
      // Minimum-N gate: categories with fewer than MIN_CATEGORY_N total signals
      // are excluded from categoryAccuracy because `1/(1+0) = 100%` reads
      // identically to `100/(100+0) = 100%` to a user glancing at a bar chart.
      // A sparse category inflates the "gemini is 100% in trust_boundaries"
      // story even when trust_boundaries has a single signal. Categories with
      // too few samples are still exposed via the raw categoryCorrect /
      // categoryHallucinated counters below, so the dashboard can render them
      // dimmed or mark them as "sparse" rather than hide them silently.
      //
      // Peer metrics (uniqueness, impactScore) both apply `1 - exp(-N/10)`
      // confidence gating — categoryAccuracy was the lone holdout.
      const MIN_CATEGORY_N = 5;
      const categoryAccuracy: Record<string, number> = {};
      const allCategories = new Set([
        ...Object.keys(a.categoryCorrect),
        ...Object.keys(a.categoryHallucinated),
      ]);
      for (const cat of allCategories) {
        const c = a.categoryCorrect[cat] ?? 0;
        const h = a.categoryHallucinated[cat] ?? 0;
        if (c + h >= MIN_CATEGORY_N) categoryAccuracy[cat] = c / (c + h);
      }

      const consec = consecutiveFailures.get(id) || 0;
      scores.set(id, {
        agentId: id, accuracy, uniqueness, reliability, impactScore,
        totalSignals: a.totalSignals,
        agreements: a.agreements,
        disagreements: a.disagreements,
        uniqueFindings: a.uniqueFindings,
        hallucinations: a.hallucinations,
        consecutiveFailures: consec,
        circuitOpen: consec >= CIRCUIT_BREAKER_THRESHOLD,
        categoryStrengths: a.categoryStrengths,
        categoryCorrect: { ...a.categoryCorrect },
        categoryHallucinated: { ...a.categoryHallucinated },
        categoryAccuracy,
      });
    }

    return scores;
  }

  private computePeerDiversity(signals: ConsensusSignal[]): Map<string, number> {
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
      const now = Date.now();
      const expiryMs = now - SIGNAL_EXPIRY_DAYS * 86400000;
      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      let pass = 0, fail = 0, approved = 0, rejected = 0, lastImplSignalMs = 0;
      for (const line of lines) {
        try {
          const s = JSON.parse(line);
          if (s.type !== 'impl' || s.agentId !== agentId) continue;
          const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
          if (ts < expiryMs) continue;
          if (ts > lastImplSignalMs) lastImplSignalMs = ts;
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
      let reliability = clamp(passRate * 0.6 + peerApproval * 0.4, 0, 1);

      // Time-based decay: mirror the same pattern used in computeScores() (line 356–361).
      // Good agents (reliability >= 0.5) decay with 7-day half-life toward neutral.
      // Poor agents (reliability < 0.5) recover more slowly (21-day half-life).
      if (lastImplSignalMs > 0) {
        const daysSince = (now - lastImplSignalMs) / 86400000;
        const halfLife = reliability >= 0.5 ? 7 : 21;
        const freshness = Math.pow(0.5, daysSince / halfLife);
        reliability = 0.5 + (reliability - 0.5) * freshness;
      }

      return { passRate, peerApproval, reliability: clamp(reliability, 0, 1) };
    } catch { return null; }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
