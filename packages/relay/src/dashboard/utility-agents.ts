export const UTILITY_AGENT_IDS = new Set(['_utility']);
export function isUtilityAgent(agentId: string): boolean {
  return UTILITY_AGENT_IDS.has(agentId);
}
