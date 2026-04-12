/**
 * Cross-reviewer selection heuristic — picks the best agents per finding
 * for Phase 2 cross-review based on accuracy, category expertise, and
 * severity-scaled adaptive epsilon-greedy exploration.
 *
 * Spec: docs/specs/2026-04-10-relay-only-consensus.md lines 32-116 (Step 2)
 */

import { PerformanceReader } from './performance-reader';
import { extractCategories } from './category-extractor';

export interface FindingForSelection {
  id: string;
  originalAuthor: string;
  content: string;
  declaredCategory?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface AgentCandidate {
  agentId: string;
}

interface ScoredCandidate {
  agent: AgentCandidate;
  score: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Select cross-reviewers for each finding.
 *
 * Returns Map<agentId, Set<findingId>> — grouped by reviewer so callers can
 * dispatch each reviewer once with all their assigned findings batched.
 *
 * Algorithm:
 * 1. Extract category from finding content (server-side authoritative), fall
 *    back to declaredCategory, or null.
 * 2. Exclude the original author and circuit-open agents.
 * 3. Score each candidate: accuracy * 0.7 + categoryAccuracy[cat] * 0.3.
 *    When category is null or unknown, compete on accuracy alone (0.3 term = 0).
 * 4. K = 3 for critical findings, 2 for all others.
 * 5. Take top-K eligible (score > 0), min(K, eligible.length).
 * 6. Severity-scaled epsilon-greedy: explore toward signal-starved below-median
 *    candidates. Epsilon = starvation * sevScale. Critical findings cap at ~4.5%.
 * 7. Group assignments by reviewer and return.
 */
export function selectCrossReviewers(
  findings: FindingForSelection[],
  allAgents: AgentCandidate[],
  performanceReader: PerformanceReader,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  for (const finding of findings) {
    // Step 1: Resolve category — server-side extraction is authoritative
    const extracted = extractCategories(finding.content);
    const category: string | null = extracted.length > 0
      ? extracted[0]
      : (finding.declaredCategory ?? null);

    // Step 2: Filter candidates — exclude original author and circuit-open agents
    const candidates = allAgents.filter(
      a => a.agentId !== finding.originalAuthor && !performanceReader.isCircuitOpen(a.agentId),
    );

    // Step 3: Score candidates
    const scoredCandidates: ScoredCandidate[] = candidates.map(agent => {
      const agentScore = performanceReader.getAgentScore(agent.agentId);
      const accuracy = agentScore?.accuracy ?? 0;
      const catAccuracy = (category !== null && agentScore?.categoryAccuracy[category] !== undefined)
        ? agentScore.categoryAccuracy[category]
        : null;
      const score = catAccuracy !== null
        ? accuracy * 0.7 + catAccuracy * 0.3
        : accuracy; // accuracy-only when no category data
      return { agent, score };
    });

    // Step 4: K by severity
    const K = finding.severity === 'critical' ? 3 : 2;

    // Step 5: Top-K eligible (score > 0)
    const eligible = scoredCandidates.filter(c => c.score > 0);
    let topK = eligible
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(K, eligible.length));

    // Step 5a: Fallback for all-zero-score pools (fresh agents with no signals)
    // When no eligible agents exist, fall back to selecting K agents by random
    // order to ensure findings always get cross-reviewed, even in fresh pools.
    if (topK.length === 0 && candidates.length > 0) {
      const shuffled = candidates.map(agent => ({ agent, score: 0 }))
        .sort(() => Math.random() - 0.5);
      topK = shuffled.slice(0, Math.min(K, shuffled.length));
    }

    // Step 6: Severity-scaled adaptive epsilon-greedy exploration
    const medianScore = median(scoredCandidates.map(c => c.score));
    const topKSet = new Set(topK.map(c => c.agent.agentId));
    const belowMedian = scoredCandidates.filter(
      c => c.score > 0 && c.score <= medianScore && !topKSet.has(c.agent.agentId),
    );

    if (belowMedian.length > 0) {
      // Signal starvation — look at the most signal-starved below-median candidate
      // Note: belowMedian is already filtered to score > 0 in the filter above
      const signalCounts = belowMedian.map(c =>
        performanceReader.getRecentCrossReviewCount(c.agent.agentId, 30),
      );
      const minSignals = Math.min(...signalCounts);
      const starvation = minSignals < 10 ? 0.30
        : minSignals > 50 ? 0.05
        : 0.15;

      const sevScale = finding.severity === 'critical' ? 0.15
        : finding.severity === 'high' ? 0.35
        : finding.severity === 'low' ? 1.00
        : 0.70; // medium (default)

      const epsilon = starvation * sevScale;

      if (topK.length === K && Math.random() < epsilon) {
        // Weighted selection toward most signal-starved candidate
        const weights = belowMedian.map((_c, i) => 1 / (1 + signalCounts[i]));
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * totalWeight;
        let pick = belowMedian[0];
        for (let i = 0; i < belowMedian.length; i++) {
          r -= weights[i];
          if (r <= 0) { pick = belowMedian[i]; break; }
        }
        // Replace weakest top-K slot (last element after desc sort)
        topK[topK.length - 1] = pick;
      }
    }

    // Step 7: Group by reviewer
    for (const { agent } of topK) {
      const assigned = result.get(agent.agentId) ?? new Set<string>();
      assigned.add(finding.id);
      result.set(agent.agentId, assigned);
    }
  }

  return result;
}
