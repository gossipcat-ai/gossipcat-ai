/**
 * PerformanceReader — reads agent-performance.jsonl and computes
 * per-agent scores from consensus signals.
 *
 * Closes the feedback loop: consensus signals → agent scores → dispatch preference.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { ConsensusSignal, ImplSignal, PerformanceSignal } from './consensus-types';
import { normalizeSkillName } from './skill-name';

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
  /** Unverified signals emitted by this agent as a reviewer — "I can't verify peer's finding". */
  unverifiedsEmitted: number;
  /** Unverified signals received by this agent as a finding author — a peer couldn't verify the citation. */
  unverifiedsReceived: number;
  weightedHallucinations: number; // decay-weighted hallucination count (used by auto-bench)
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
const NEGATIVE_SIGNALS = new Set(['hallucination_caught', 'disagreement']);
const NEGATIVE_IMPL_SIGNALS = new Set(['impl_test_fail', 'impl_peer_rejected']);
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
  consensus_round_retracted: true,
  severity_miscalibrated: true,
  task_timeout: true,
  task_empty: true,
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

  /**
   * Return the set of consensus round IDs that have been retracted via
   * `gossip_signals({action:'retract', consensus_id, reason})`. Dashboard
   * uses this to render banners and strike-through on retracted rounds.
   */
  getRetractedConsensusIds(): Set<string> {
    if (!existsSync(this.filePath)) return new Set();
    try {
      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const ids = new Set<string>();
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r && r.type === 'consensus' && r.signal === 'consensus_round_retracted' && typeof r.consensus_id === 'string') {
            ids.add(r.consensus_id);
          }
        } catch { /* skip */ }
      }
      return ids;
    } catch {
      return new Set();
    }
  }

  /**
   * Return all round-retraction tombstone entries, preserving duplicates
   * so an admin view can see multiple retraction reasons for the same round.
   */
  getRoundRetractions(): Array<{ consensus_id: string; reason: string; retracted_at: string }> {
    if (!existsSync(this.filePath)) return [];
    try {
      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const out: Array<{ consensus_id: string; reason: string; retracted_at: string }> = [];
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r && r.type === 'consensus' && r.signal === 'consensus_round_retracted' && typeof r.consensus_id === 'string') {
            out.push({
              consensus_id: r.consensus_id,
              reason: typeof r.reason === 'string' ? r.reason : '',
              retracted_at: typeof r.retracted_at === 'string' ? r.retracted_at : (r.timestamp || ''),
            });
          }
        } catch { /* skip */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Check if an agent's circuit breaker is open (3+ consecutive failures) */
  isCircuitOpen(agentId: string): boolean {
    const score = this.getAgentScore(agentId);
    return score?.circuitOpen ?? false;
  }

  /**
   * Agent auto-bench v1 — chronic-low-accuracy or burst-hallucination gate.
   *
   * Returns {benched:false} for healthy agents.
   * Returns {benched:true, reason} when a bench rule fires AND the safeguard
   * passes (another unbenched agent covers every category in `categories`).
   * Returns {benched:false, safeguardBlocked:true, reason} when a bench rule
   * fires but the candidate is the sole provider of one of the requested
   * categories (benching would leave that category uncovered).
   *
   * Hysteresis: the 5pp margin between the Rule A entry threshold (acc < 0.30)
   * and the natural recovery point (acc >= 0.35, where `0.30 enter / 0.35 exit`
   * is the conventional window) acts as implicit hysteresis via the score
   * window itself. TODO(v2): explicit post-bench clean-streak counter if the
   * implicit window proves too flappy in production.
   */
  isBenched(
    agentId: string,
    categories?: string[],
    allAgentIds?: string[],
  ): { benched: boolean; reason?: string; safeguardBlocked?: boolean } {
    const score = this.getAgentScore(agentId);
    if (!score) return { benched: false };

    // Rule A: chronic low accuracy (needs enough evidence to be statistically meaningful)
    const ruleA = score.accuracy < 0.30 && score.totalSignals >= 200;
    // Rule B: burst hallucinations (absolute floor + rate gate)
    const hallRate = score.totalSignals > 0
      ? score.weightedHallucinations / score.totalSignals
      : 0;
    const ruleB = score.weightedHallucinations >= 5 && hallRate > 0.4;

    if (!ruleA && !ruleB) return { benched: false };

    const reason = ruleA ? 'chronic-low-accuracy' : 'burst-hallucination';

    // Safeguard: if the caller specified categories the agent covers, ensure
    // at least one *other* non-benched agent covers each category. If the
    // candidate is the sole provider of any requested category, refuse to
    // bench — partial coverage is worse than a struggling reviewer.
    if (categories && categories.length > 0 && allAgentIds && allAgentIds.length > 0) {
      for (const cat of categories) {
        let covered = false;
        for (const other of allAgentIds) {
          if (other === agentId) continue;
          const otherScore = this.getAgentScore(other);
          if (!otherScore) continue;
          const otherCats = otherScore.categoryAccuracy || {};
          if (!(cat in otherCats)) continue;
          // Recurse with no categories to avoid unbounded stack and to answer
          // the simple question: "would this *other* agent be benched on its
          // own merits?" If not, it's a valid fallback reviewer.
          const otherBench = this.isBenched(other);
          if (!otherBench.benched) { covered = true; break; }
        }
        if (!covered) return { benched: false, safeguardBlocked: true, reason };
      }
    }

    return { benched: true, reason };
  }

  /**
   * Count how many cross-review signals an agent has received in the last `days` days.
   * Cross-review signal types: agreement, disagreement, unverified, new_finding.
   * Uses readSignals() which already applies the 30-day expiry — the `days` param
   * narrows that window further for callers that want a shorter lookback.
   */
  getRecentCrossReviewCount(agentId: string, days: number): number {
    const CROSS_REVIEW_SIGNALS = new Set<ConsensusSignal['signal']>(['agreement', 'disagreement', 'unverified', 'new_finding']);
    const cutoffMs = Date.now() - days * 86400000;
    const signals = this.readSignals();
    return signals.filter(s => {
      if (s.agentId !== agentId) return false;
      if (s.type !== 'consensus') return false;
      if (!CROSS_REVIEW_SIGNALS.has(s.signal)) return false;
      const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
      return isFinite(ts) && ts > cutoffMs;
    }).length;
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
    const normalizedTarget = normalizeSkillName(category);

    for (const s of allSignals) {
      if (s.agentId !== agentId) continue;
      // Empty/missing category is not a match. Aligns with `computeScores` at
      // :392, :450 (both guard with `if (signal.category)` before populating
      // categoryStrengths/categoryHallucinated) — an empty-string category
      // should never satisfy a category-specific counter query.
      if (!s.category) continue;
      if (normalizeSkillName(s.category) !== normalizedTarget) continue;
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
      // Collect round-level retracted consensus IDs (tombstone rows).
      const retractedConsensusIds = new Set<string>();
      for (const s of all) {
        if (s.signal === 'consensus_round_retracted') {
          const cid = (s as any).consensus_id;
          if (typeof cid === 'string' && cid.length > 0) retractedConsensusIds.add(cid);
          continue;
        }
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

      // Filter: exclude retracted signals, tombstones, and the retraction signals themselves
      return all.filter(s => {
        if (s.signal === 'signal_retracted') return false;
        if (s.signal === 'consensus_round_retracted') return false;
        // Exclude sentinel rows from per-agent aggregation defence-in-depth
        if (s.agentId === '_system') return false;
        // Round-level: drop any consensus signal whose findingId sits inside a retracted round
        if (s.type === 'consensus' && (s as any).findingId) {
          const fid = (s as any).findingId as string;
          for (const retractedId of retractedConsensusIds) {
            if (fid.startsWith(retractedId + ':')) return false;
          }
        }
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

  private readSignals(): PerformanceSignal[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const expiryMs = Date.now() - SIGNAL_EXPIRY_DAYS * 86400000;

      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      const all = lines.map(line => {
        try { return JSON.parse(line) as PerformanceSignal; }
        catch { return null; }
      }).filter((s): s is PerformanceSignal =>
        s !== null &&
        (s.type === 'consensus' || s.type === 'impl') &&
        typeof s.agentId === 'string' && s.agentId.length > 0
      );

      // Collect retraction keys: agentId + taskId + signalType combos that have been retracted
      // Only consensus signals can carry retractions.
      const retracted = new Set<string>();
      // Round-level retracted consensus IDs (tombstone rows).
      const retractedConsensusIds = new Set<string>();
      for (const s of all) {
        if (s.type !== 'consensus') continue;
        if (s.signal === 'consensus_round_retracted') {
          const cid = (s as any).consensus_id;
          if (typeof cid === 'string' && cid.length > 0) retractedConsensusIds.add(cid);
          continue;
        }
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

      // Filter: exclude expired, retracted, tombstones, and retraction signals themselves
      return all.filter(s => {
        if (s.type === 'consensus' && s.signal === 'signal_retracted') return false;
        if (s.type === 'consensus' && s.signal === 'consensus_round_retracted') return false;
        // Drop sentinel rows from per-agent aggregation defence-in-depth
        if (s.agentId === '_system') return false;
        // Expire old signals — missing/bad timestamps are treated as expired
        const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
        if (!isFinite(ts) || ts === 0 || ts < expiryMs) return false;
        // Skip retracted signals (check both scoped and wildcard keys; impl signals are never retracted)
        if (s.type === 'consensus') {
          const taskKey = s.taskId || s.timestamp;
          if (retracted.has(s.agentId + ':' + taskKey + ':' + s.signal)) return false;
          if (retracted.has(s.agentId + ':' + taskKey + ':*')) return false;
          // Round-level: drop consensus signals whose findingId sits inside a retracted round.
          // Use startsWith(cid + ':') — finding_id shapes: `<cid>:fN` (bulk) and
          // `<cid>:<agent>:fN` (manual). ImplSignal has no findingId so impl signals
          // are structurally unaffected.
          const fid = (s as any).findingId;
          if (typeof fid === 'string' && fid.length > 0) {
            for (const retractedId of retractedConsensusIds) {
              if (fid.startsWith(retractedId + ':')) return false;
            }
          }
        }
        return true;
      });
    } catch {
      return [];
    }
  }

  private computeScores(signals: PerformanceSignal[]): Map<string, AgentScore> {
    const DECAY_HALF_LIFE = 50; // tasks
    // Shorter half-life for hallucination penalties so agents can recover from old
    // mistakes faster once they stop repeating them. Empirical calibration: 20 gives
    // gemini-reviewer (17 historical hallucinations) an accuracy of ~0.52 vs the
    // 0.28 the 50-task half-life produced — enough headroom to come off the
    // "avoid as sole reviewer" list after a clean run, without erasing the
    // penalty entirely. Decay tune alone is sufficient; do NOT also adjust the
    // 0.3 coefficient on hallucinationMultiplier below. See spec
    // docs/specs/2026-04-16-hallucination-decay-tune.md.
    const HALLUCINATION_DECAY_HALF_LIFE = 20; // tasks

    const TIME_DECAY_HALF_LIFE_DAYS = 7; // scores drift toward neutral after a week of inactivity
    const now = Date.now();

    // Split into typed arrays once so remaining code keeps narrow types.
    // consensusSignals → scoring + streak building.
    // implSignals      → streak building only (scoring is handled separately by getImplScore).
    const consensusSignals = signals.filter((s): s is ConsensusSignal => s.type === 'consensus');
    const implSignals = signals.filter((s): s is ImplSignal => s.type === 'impl');

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
      unverifiedsEmitted: number;
      unverifiedsReceived: number;
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
        unverifiedsEmitted: 0, unverifiedsReceived: 0,
        totalSignals: 0, lastSignalMs: 0, categoryStrengths: {},
        categoryCorrect: {}, categoryHallucinated: {},
      });
      return acc.get(id)!;
    };

    // Index task order per agent for decay calculation
    // Index both agentId and counterpartId so winners get correct decay
    for (const signal of consensusSignals) {
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

    const peerDiversity = this.computePeerDiversity(consensusSignals);

    // Build per-agent retraction index so computeScores skips retracted signals
    // even when called with a raw (unfiltered) signal array (e.g. directly from tests).
    const retractedKeys = new Set<string>();
    const retractedConsensusIds = new Set<string>();
    for (const signal of consensusSignals) {
      if (signal.signal === 'consensus_round_retracted') {
        const cid = (signal as any).consensus_id;
        if (typeof cid === 'string' && cid.length > 0) retractedConsensusIds.add(cid);
        continue;
      }
      if (signal.signal === 'signal_retracted') {
        const taskKey = signal.taskId || signal.timestamp;
        if (signal.retractedSignal) {
          retractedKeys.add(signal.agentId + ':' + taskKey + ':' + signal.retractedSignal);
        } else {
          retractedKeys.add(signal.agentId + ':' + taskKey + ':*');
        }
      }
    }

    for (const signal of consensusSignals) {
      const isKnown = KNOWN_SIGNALS[signal.signal];
      if (!isKnown) continue;
      if (signal.signal === 'signal_retracted') continue;
      if (signal.signal === 'consensus_round_retracted') continue;
      // Tombstone sentinel rows have no real agent — ignore.
      if (signal.agentId === '_system') continue;

      // Round-level retraction — drop any signal whose findingId sits inside a retracted round.
      const fidAny = (signal as any).findingId;
      if (typeof fidAny === 'string' && fidAny.length > 0) {
        let dropped = false;
        for (const retractedId of retractedConsensusIds) {
          if (fidAny.startsWith(retractedId + ':')) { dropped = true; break; }
        }
        if (dropped) continue;
      }

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
          a.weightedTotal += sevMul * decay * diversityMul;
          a.agreements++;
          a.weightedImpact += sevMul * decay;
          a.weightedConfirmedCount += decay;
          if (signal.category) {
            a.categoryStrengths[signal.category] = (a.categoryStrengths[signal.category] ?? 0) + sevMul * decay * 0.15 * diversityMul;
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
            const winnerDiversityMul = peerDiversity.get(signal.counterpartId) ?? 1;
            winner.weightedCorrect += sevMul * wd * winnerDiversityMul;
            winner.weightedTotal += sevMul * wd * winnerDiversityMul;
            if (signalMs > winner.lastSignalMs) winner.lastSignalMs = signalMs;
          }
          if (signal.category) {
            a.categoryHallucinated[signal.category] = (a.categoryHallucinated[signal.category] ?? 0) + 1;
          }
          break;
        }
        case 'unverified': {
          // Near-neutral cost — "I don't know" is not evidence of incorrectness.
          // Tracked in both directions for dashboard visibility:
          // - emitted: this agent couldn't verify a peer's finding (reviewer role)
          // - received: a peer couldn't verify THIS agent's finding (author role)
          a.weightedTotal += decay * 0.02;
          a.unverifiedsEmitted++;
          if (signal.counterpartId && signal.counterpartId.length > 0) {
            const author = ensure(signal.counterpartId);
            author.unverifiedsReceived++;
          }
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
          // Use a dedicated (shorter) half-life for the hallucination counter so
          // past mistakes can be outrun by recent good behavior. `weightedTotal`
          // keeps the original DECAY_HALF_LIFE so the denominator that defines
          // "overall cross-review activity" stays stable — only the numerator on
          // the penalty side fades faster.
          const hallucDecay = Math.pow(0.5, tasksSince / HALLUCINATION_DECAY_HALF_LIFE);
          a.weightedHallucinations += severity * hallucDecay;
          a.weightedTotal += decay;
          a.hallucinations++;
          if (signal.category) {
            a.categoryHallucinated[signal.category] = (a.categoryHallucinated[signal.category] ?? 0) + 1;
          }
          break;
        }
        case 'task_timeout':
        case 'task_empty':
          // Transport/provider failure — contributes nothing to any scoring accumulator.
          // Does not affect accuracy, uniqueness, reliability, or circuit breaker.
          break;
      }
    }

    // Circuit breaker: count consecutive trailing failures per agent.
    // Accepts both consensus signals (using KNOWN_SIGNALS + NEGATIVE_SIGNALS) and impl
    // signals (using NEGATIVE_IMPL_SIGNALS), so a clean impl run can reset a stale
    // consensus-side streak and vice versa.
    const consecutiveFailures = new Map<string, number>();
    // Group eligible signals by agent; preserve insertion order for sort.
    const signalsByAgent = new Map<string, (ConsensusSignal | ImplSignal)[]>();
    for (const signal of consensusSignals) {
      if (!KNOWN_SIGNALS[signal.signal]) continue;
      const list = signalsByAgent.get(signal.agentId) || [];
      list.push(signal);
      signalsByAgent.set(signal.agentId, list);
    }
    for (const signal of implSignals) {
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
      // Walk from newest to oldest — count consecutive negatives at tail.
      // A non-negative signal (positive consensus or positive impl) breaks the streak.
      for (let i = agentSignals.length - 1; i >= 0; i--) {
        const sig = agentSignals[i];
        const isNegative =
          (sig.type === 'consensus' && NEGATIVE_SIGNALS.has(sig.signal)) ||
          (sig.type === 'impl' && NEGATIVE_IMPL_SIGNALS.has(sig.signal));
        if (isNegative) streak++;
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
        unverifiedsEmitted: a.unverifiedsEmitted,
        unverifiedsReceived: a.unverifiedsReceived,
        weightedHallucinations: a.weightedHallucinations,
        consecutiveFailures: consec,
        circuitOpen: consec >= CIRCUIT_BREAKER_THRESHOLD,
        categoryStrengths: a.categoryStrengths,
        categoryCorrect: { ...a.categoryCorrect },
        categoryHallucinated: { ...a.categoryHallucinated },
        categoryAccuracy,
      });
    }

    // Agents that have ONLY impl signals (no consensus signals) won't appear in `acc`
    // but may have a non-zero consecutiveFailures from the streak loop above.
    // Emit a neutral score entry for them so circuit-breaker state is visible.
    for (const [agentId, consec] of consecutiveFailures) {
      if (!scores.has(agentId)) {
        scores.set(agentId, {
          agentId, accuracy: 0.5, uniqueness: 0.5, reliability: 0.5, impactScore: 0.5,
          totalSignals: 0, agreements: 0, disagreements: 0, uniqueFindings: 0, hallucinations: 0,
          unverifiedsEmitted: 0, unverifiedsReceived: 0,
          weightedHallucinations: 0,
          consecutiveFailures: consec,
          circuitOpen: consec >= CIRCUIT_BREAKER_THRESHOLD,
          categoryStrengths: {}, categoryCorrect: {}, categoryHallucinated: {}, categoryAccuracy: {},
        });
      }
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
