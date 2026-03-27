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
}

const SIGNAL_WEIGHTS = {
  agreement: { accuracy: 0.1 },
  disagreement: { accuracy: -0.15 },  // losing side; winning side gets bonus via counterpart
  unique_confirmed: { uniqueness: 0.2 },
  unique_unconfirmed: { uniqueness: 0.05 },
  new_finding: { uniqueness: 0.15 },
  hallucination_caught: { accuracy: -0.3 },
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

  /** Get a reliability multiplier for dispatch weighting (0.5 to 1.5) */
  getDispatchWeight(agentId: string): number {
    const score = this.getAgentScore(agentId);
    if (!score || score.totalSignals < 3) return 1.0; // not enough data, neutral
    // Map reliability (0-1) to weight (0.5-1.5)
    return 0.5 + score.reliability;
  }

  /** Invalidate cache (e.g. after writing new signals) */
  invalidateCache(): void {
    this.cachedScores = null;
    this.cachedMtimeMs = 0;
  }

  private readSignals(): ConsensusSignal[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.map(line => {
        try { return JSON.parse(line) as ConsensusSignal; }
        catch { return null; }
      }).filter((s): s is ConsensusSignal =>
        s !== null && typeof s.agentId === 'string' && s.agentId.length > 0
      );
    } catch {
      return [];
    }
  }

  private computeScores(signals: ConsensusSignal[]): Map<string, AgentScore> {
    const scores = new Map<string, AgentScore>();

    const ensure = (id: string): AgentScore => {
      if (!scores.has(id)) {
        scores.set(id, {
          agentId: id, accuracy: 0.5, uniqueness: 0.5, reliability: 0.5,
          totalSignals: 0, agreements: 0, disagreements: 0, uniqueFindings: 0, hallucinations: 0,
        });
      }
      return scores.get(id)!;
    };

    for (const signal of signals) {
      const agent = ensure(signal.agentId);

      // FIX: only count known signal types toward totalSignals threshold
      const weights = SIGNAL_WEIGHTS[signal.signal];
      if (!weights) continue;
      agent.totalSignals++;

      if ('accuracy' in weights) {
        agent.accuracy = clamp(agent.accuracy + weights.accuracy, 0, 1);
      }
      if ('uniqueness' in weights) {
        agent.uniqueness = clamp(agent.uniqueness + weights.uniqueness, 0, 1);
      }

      // Track counts
      switch (signal.signal) {
        case 'agreement': agent.agreements++; break;
        case 'disagreement': agent.disagreements++; break;
        case 'unique_confirmed':
        case 'unique_unconfirmed':
        case 'new_finding': agent.uniqueFindings++; break;
        case 'hallucination_caught': agent.hallucinations++; break;
      }

      // Counterpart bonus: when agent B gets a 'disagreement' signal (B lost),
      // the counterpartId points to agent A who won. Boost A's accuracy + count.
      if (signal.counterpartId && typeof signal.counterpartId === 'string' && signal.counterpartId.length > 0 && signal.signal === 'disagreement') {
        const winner = ensure(signal.counterpartId);
        winner.accuracy = clamp(winner.accuracy + 0.1, 0, 1);
        winner.totalSignals++; // FIX: count so winner crosses the 3-signal dispatch threshold
      }
    }

    // Compute reliability as weighted average
    for (const score of scores.values()) {
      score.reliability = clamp(score.accuracy * 0.7 + score.uniqueness * 0.3, 0, 1);
    }

    return scores;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
