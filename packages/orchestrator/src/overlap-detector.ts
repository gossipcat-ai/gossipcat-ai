import type { AgentConfig, OverlapResult } from './types';

export class OverlapDetector {
  detect(agents: AgentConfig[]): OverlapResult {
    const pairs: OverlapResult['pairs'] = [];
    const allShared = new Set<string>();

    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const shared = a.skills.filter(s => b.skills.includes(s));
        if (shared.length > 0) {
          const presetA = a.preset || 'custom';
          const presetB = b.preset || 'custom';
          const type = presetA === presetB ? 'redundant' : 'complementary';
          pairs.push({ agentA: a.id, agentB: b.id, shared, type });
          shared.forEach(s => allShared.add(s));
        }
      }
    }

    return {
      hasOverlaps: pairs.length > 0,
      agents: agents.map(a => ({ id: a.id, preset: a.preset || 'custom', skills: a.skills })),
      sharedSkills: Array.from(allShared),
      pairs,
    };
  }

  formatWarning(result: OverlapResult): string | null {
    const redundant = result.pairs.filter(p => p.type === 'redundant');
    if (redundant.length === 0) return null;
    return redundant.map(p =>
      `${p.agentA} ∩ ${p.agentB} (same preset): ${p.shared.join(', ')}`
    ).join('\n  ');
  }
}
