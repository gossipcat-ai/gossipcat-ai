/**
 * DispatchDifferentiator — generates per-agent focus prompts from
 * competency profiles. Deterministic (no LLM call).
 *
 * Privacy rule: prompts never reveal peer names, scores, or weaknesses.
 */

import { AgentScore } from './performance-reader';

const CATEGORY_LABELS: Record<string, string> = {
  trust_boundaries: 'trust boundaries and authentication',
  injection_vectors: 'injection vectors and input sanitization',
  input_validation: 'input validation and schema enforcement',
  concurrency: 'concurrency, race conditions, and atomicity',
  resource_exhaustion: 'resource exhaustion and DoS vectors',
  type_safety: 'type safety and TypeScript strictness',
  error_handling: 'error handling and fallback paths',
  data_integrity: 'data integrity and consistency',
};

export class DispatchDifferentiator {
  /**
   * Generate differentiation prompts for co-dispatched agents.
   * Returns empty map if:
   *   - single agent (no differentiation needed)
   *   - all profiles have empty strengths (cold start — caller should fall back to lens-generator)
   */
  differentiate(profiles: AgentScore[], _task: string): Map<string, string> {
    if (profiles.length < 2) return new Map();

    // Get top strengths per agent
    const agentStrengths = new Map<string, string[]>();
    for (const p of profiles) {
      const sorted = Object.entries(p.categoryStrengths)
        .filter(([, score]) => score > 0.5)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([cat]) => cat);
      agentStrengths.set(p.agentId, sorted);
    }

    // If all agents have empty strengths, return empty (cold start)
    const allEmpty = [...agentStrengths.values()].every(s => s.length === 0);
    if (allEmpty) return new Map();

    // Assign focus areas — each agent gets its strongest categories
    // Categories assigned to one agent are deprioritized for others
    const assigned = new Set<string>();
    const focusMap = new Map<string, string[]>();

    // Sort agents by most specialized first (most unique strengths)
    const sortedAgents = [...agentStrengths.entries()]
      .sort(([, a], [, b]) => b.length - a.length);

    for (const [agentId, strengths] of sortedAgents) {
      const focus: string[] = [];
      for (const cat of strengths) {
        if (!assigned.has(cat)) {
          focus.push(cat);
          assigned.add(cat);
        }
      }
      // If agent has no unique strengths, give it unassigned categories
      if (focus.length === 0) {
        const unassigned = Object.keys(CATEGORY_LABELS).filter(c => !assigned.has(c));
        if (unassigned.length > 0) {
          focus.push(unassigned[0]);
          assigned.add(unassigned[0]);
        }
      }
      focusMap.set(agentId, focus);
    }

    // Generate prompts
    const result = new Map<string, string>();
    for (const [agentId, focus] of focusMap) {
      if (focus.length === 0) continue;
      const labels = focus.map(c => CATEGORY_LABELS[c] || c).join(', ');
      result.set(agentId,
        `Focus your review on ${labels}. ` +
        `Other aspects are covered by your peers. ` +
        `Prioritize depth over breadth in your focus area.`
      );
    }

    return result;
  }
}
