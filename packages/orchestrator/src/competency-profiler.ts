/**
 * CompetencyProfiler — computes per-agent CompetencyProfile from
 * agent-performance.jsonl with score decay and anti-gaming measures.
 * In-memory only — no disk cache. Uses mtime-based invalidation.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { ConsensusSignal, ImplSignal, PerformanceSignal } from './consensus-types';

export interface CompetencyProfile {
  agentId: string;
  reviewStrengths: Record<string, number>;
  implPassRate: number;
  implIterations: number;
  implPeerApproval: number;
  speed: number;
  hallucinationRate: number;
  avgTokenCost: number;
  totalTasks: number;
  reviewReliability: number;
  implReliability: number;
}

const DECAY_HALF_LIFE = 50;
const MIN_TASKS_THRESHOLD = 10;
const MAX_ACCURACY_CHANGE_PER_ROUND = 0.3;
const AGREEMENT_WEIGHT = 0.1;
const DISAGREEMENT_WEIGHT = -0.15;
export class CompetencyProfiler {
  private readonly filePath: string;
  private cachedProfiles: Map<string, CompetencyProfile> | null = null;
  private cachedMtimeMs = 0;

  constructor(projectRoot: string) {
    this.filePath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  }

  getProfile(agentId: string): CompetencyProfile | null {
    const profiles = this.getProfiles();
    return profiles.get(agentId) ?? null;
  }

  getProfiles(): Map<string, CompetencyProfile> {
    let mtimeMs = 0;
    try { mtimeMs = statSync(this.filePath).mtimeMs; } catch { /* file doesn't exist */ }
    if (this.cachedProfiles && mtimeMs === this.cachedMtimeMs) {
      return this.cachedProfiles;
    }
    this.cachedProfiles = this.computeProfiles();
    this.cachedMtimeMs = mtimeMs;
    return this.cachedProfiles;
  }

  /** Get profileMultiplier for dispatch (clamped 0.5-1.5, neutral if < threshold) */
  getProfileMultiplier(agentId: string, taskType: 'review' | 'impl'): number {
    const profile = this.getProfile(agentId);
    if (!profile || profile.totalTasks < MIN_TASKS_THRESHOLD) return 1.0;
    if (taskType === 'review') {
      const raw = profile.reviewReliability * (1 - profile.hallucinationRate);
      return clamp(raw * 2, 0.5, 1.5);
    }
    // If agent has no impl data, return neutral — don't penalize review-only agents
    if (profile.implPassRate === 0.5 && profile.implPeerApproval === 0.5 && profile.implReliability === 0.5) {
      return 1.0;
    }
    const raw = profile.implReliability * profile.implPassRate;
    return clamp(raw * 2, 0.5, 1.5);
  }

  private computeProfiles(): Map<string, CompetencyProfile> {
    const signals = this.readSignals();
    const profiles = new Map<string, CompetencyProfile>();

    // Build task index per agent (for decay ordering and threshold)
    // Uses Map<taskId, index> for O(1) lookup instead of Array.indexOf O(n)
    const taskCountByAgent = new Map<string, number>();
    const taskIndexByAgent = new Map<string, Map<string, number>>();
    for (const s of signals) {
      if (s.type === 'meta' && s.signal === 'task_completed') {
        const count = taskCountByAgent.get(s.agentId) ?? 0;
        if (!taskIndexByAgent.has(s.agentId)) taskIndexByAgent.set(s.agentId, new Map());
        taskIndexByAgent.get(s.agentId)!.set(s.taskId, count);
        taskCountByAgent.set(s.agentId, count + 1);
      }
    }

    const ensure = (id: string): CompetencyProfile => {
      if (!profiles.has(id)) {
        profiles.set(id, {
          agentId: id, reviewStrengths: {},
          implPassRate: 0.5, implIterations: 0, implPeerApproval: 0.5,
          speed: 0, hallucinationRate: 0, avgTokenCost: 0,
          totalTasks: 0, reviewReliability: 0.5, implReliability: 0.5,
        });
      }
      return profiles.get(id)!;
    };

    // Pass 1: count tasks and compute meta stats
    const iterationCounts = new Map<string, number>();
    for (const s of signals) {
      if (s.type === 'meta') {
        const p = ensure(s.agentId);
        if (s.signal === 'task_completed') {
          const prevCount = p.totalTasks;
          p.totalTasks++;
          if (s.value) {
            p.speed = prevCount === 0 ? s.value : (p.speed * prevCount + s.value) / p.totalTasks;
          }
        }
        if (s.signal === 'task_tool_turns' && s.value) {
          // Running average using count of tool_turns signals seen
          if (!iterationCounts.has(s.agentId)) iterationCounts.set(s.agentId, 0);
          const count = iterationCounts.get(s.agentId)!;
          p.implIterations = count === 0 ? s.value : (p.implIterations * count + s.value) / (count + 1);
          iterationCounts.set(s.agentId, count + 1);
        }
      }
    }

    // Pass 2: compute review scores with decay + anti-gaming
    const peerDiversity = this.computePeerDiversity(signals);
    const roundChanges = new Map<string, Map<string, number>>();

    const accuracy = new Map<string, number>();
    const uniqueness = new Map<string, number>();
    const hallucinations = new Map<string, { caught: number }>();

    for (const s of signals) {
      if (s.type !== 'consensus') continue;
      const cs = s as ConsensusSignal;
      const p = ensure(cs.agentId);
      const totalTasks = taskCountByAgent.get(cs.agentId) ?? 0;
      const taskIndex = taskIndexByAgent.get(cs.agentId)?.get(cs.taskId) ?? -1;
      // Missing taskId gets half-life decay (conservative default) instead of max weight
      const tasksSince = taskIndex >= 0 ? totalTasks - taskIndex - 1 : DECAY_HALF_LIFE;
      const decay = Math.pow(0.5, tasksSince / DECAY_HALF_LIFE);

      if (!roundChanges.has(cs.agentId)) roundChanges.set(cs.agentId, new Map());
      const agentRounds = roundChanges.get(cs.agentId)!;
      const currentRoundChange = agentRounds.get(cs.taskId) ?? 0;

      if (cs.signal === 'agreement') {
        const diversity = peerDiversity.get(cs.agentId) ?? 1;
        const change = AGREEMENT_WEIGHT * decay * diversity;
        if (Math.abs(currentRoundChange + change) <= MAX_ACCURACY_CHANGE_PER_ROUND) {
          const acc = accuracy.get(cs.agentId) ?? 0.5;
          accuracy.set(cs.agentId, clamp(acc + change, 0, 1));
          agentRounds.set(cs.taskId, currentRoundChange + change);
        }
      }

      if (cs.signal === 'disagreement') {
        const change = DISAGREEMENT_WEIGHT * decay;
        if (Math.abs(currentRoundChange + change) <= MAX_ACCURACY_CHANGE_PER_ROUND) {
          const acc = accuracy.get(cs.agentId) ?? 0.5;
          accuracy.set(cs.agentId, clamp(acc + change, 0, 1));
          agentRounds.set(cs.taskId, currentRoundChange + change);
        }
      }

      if (cs.signal === 'unique_confirmed' || cs.signal === 'new_finding') {
        const boost = cs.signal === 'unique_confirmed' ? 0.2 : 0.15;
        const u = uniqueness.get(cs.agentId) ?? 0.5;
        uniqueness.set(cs.agentId, clamp(u + boost * decay, 0, 1));
      }

      if (cs.signal === 'unique_unconfirmed') {
        const u = uniqueness.get(cs.agentId) ?? 0.5;
        uniqueness.set(cs.agentId, clamp(u + 0.05 * decay, 0, 1));
      }

      if (cs.signal === 'hallucination_caught') {
        // agentId on hallucination_caught = the agent whose finding was challenged
        const h = hallucinations.get(cs.agentId) ?? { caught: 0 };
        h.caught++;
        hallucinations.set(cs.agentId, h);
      }

      if (cs.signal === 'category_confirmed' && cs.category) {
        const strength = p.reviewStrengths[cs.category] ?? 0.5;
        p.reviewStrengths[cs.category] = clamp(strength + 0.15 * decay, 0, 1);
      }
    }

    // Pass 3: impl signals
    const implStats = new Map<string, { pass: number; fail: number; approved: number; rejected: number }>();
    for (const s of signals) {
      if (s.type !== 'impl') continue;
      const is = s as ImplSignal;
      const stats = implStats.get(is.agentId) ?? { pass: 0, fail: 0, approved: 0, rejected: 0 };
      if (is.signal === 'impl_test_pass') stats.pass++;
      if (is.signal === 'impl_test_fail') stats.fail++;
      if (is.signal === 'impl_peer_approved') stats.approved++;
      if (is.signal === 'impl_peer_rejected') stats.rejected++;
      implStats.set(is.agentId, stats);
    }

    // Finalize profiles
    for (const [id, p] of profiles) {
      const acc = accuracy.get(id) ?? 0.5;
      const uniq = uniqueness.get(id) ?? 0.5;
      p.reviewReliability = clamp(acc * 0.7 + uniq * 0.3, 0, 1);

      const h = hallucinations.get(id);
      if (h && h.caught > 0) {
        // Denominator = total findings this agent produced (unique_confirmed + unique_unconfirmed + new_finding)
        const totalFindings = signals.filter(s =>
          s.type === 'consensus' && s.agentId === id &&
          ['unique_confirmed', 'unique_unconfirmed', 'new_finding'].includes((s as ConsensusSignal).signal)
        ).length;
        p.hallucinationRate = totalFindings > 0 ? clamp(h.caught / totalFindings, 0, 1) : 0;
      }

      const impl = implStats.get(id);
      if (impl) {
        const implTotal = impl.pass + impl.fail;
        p.implPassRate = implTotal > 0 ? impl.pass / implTotal : 0.5;
        const peerTotal = impl.approved + impl.rejected;
        p.implPeerApproval = peerTotal > 0 ? impl.approved / peerTotal : 0.5;
        p.implReliability = clamp(p.implPassRate * 0.6 + p.implPeerApproval * 0.4, 0, 1);
      }
    }

    return profiles;
  }

  private computePeerDiversity(signals: PerformanceSignal[]): Map<string, number> {
    const peerSets = new Map<string, Set<string>>();
    // Only count agents that participated in consensus (not impl/meta-only agents)
    const consensusAgents = new Set<string>();
    for (const s of signals) {
      if (s.type === 'consensus') consensusAgents.add(s.agentId);
      if (s.type === 'consensus' && (s as ConsensusSignal).signal === 'agreement' && (s as ConsensusSignal).counterpartId) {
        const peers = peerSets.get(s.agentId) || new Set();
        peers.add((s as ConsensusSignal).counterpartId!);
        peerSets.set(s.agentId, peers);
      }
    }
    const result = new Map<string, number>();
    for (const [agentId, peers] of peerSets) {
      const teamSize = Math.max(consensusAgents.size - 1, 1);
      result.set(agentId, Math.max(0.3, peers.size / teamSize));
    }
    return result;
  }

  private readSignals(): PerformanceSignal[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) as PerformanceSignal; }
        catch { return null; }
      }).filter((s): s is PerformanceSignal => s !== null && typeof s.agentId === 'string' && s.agentId.length > 0);
    } catch { return []; }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
