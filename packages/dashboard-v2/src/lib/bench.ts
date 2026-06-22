import type { AgentData } from './types';

export type BenchBadgeKind = 'benched' | 'struggling' | 'kept-for-coverage' | null;

/**
 * Three-state badge derivation for auto-bench v2:
 * - `benched`           — isBenched rule fired AND safeguard passed
 * - `struggling`        — legacy circuitOpen trips (consecutive failures), but
 *                          the agent is NOT bench-rule benched. Keeps the old
 *                          "too many fails in a row" signal visible without
 *                          conflating it with chronic/burst bench.
 * - `kept-for-coverage` — bench rule fired, but the agent is the sole provider
 *                          of a category, so the safeguard blocked benching.
 *                          Rendered as an amber-outline informational tag.
 */
export function getBenchBadgeKind(scores: AgentData['scores']): BenchBadgeKind {
  if (scores.bench?.state === 'benched') return 'benched';
  if (scores.circuitOpen) return 'struggling';
  if (scores.bench?.state === 'kept-for-coverage') return 'kept-for-coverage';
  return null;
}

/**
 * Dashboard-wide filter: who needs operator attention?
 * Any agent that is actively benched or tripped the legacy circuit breaker.
 * kept-for-coverage agents are informational, not alerts.
 */
export function needsAttention(agent: AgentData): boolean {
  return agent.scores.bench?.state === 'benched' || agent.scores.circuitOpen;
}
