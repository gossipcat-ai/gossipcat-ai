import { PerformanceReader, AgentScore } from '@gossip/orchestrator/performance-reader';

interface AgentConfigLike {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  skills: string[];
  native?: boolean;
}

export interface AgentResponse {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  native: boolean;
  skills: string[];
  scores: {
    accuracy: number;
    uniqueness: number;
    reliability: number;
    dispatchWeight: number;
    signals: number;
    agreements: number;
    disagreements: number;
    hallucinations: number;
  };
}

const DEFAULT_SCORE: AgentScore = {
  agentId: '', accuracy: 0.5, uniqueness: 0.5, reliability: 0.5,
  totalSignals: 0, agreements: 0, disagreements: 0, uniqueFindings: 0, hallucinations: 0,
};

export async function agentsHandler(projectRoot: string, configs: AgentConfigLike[]): Promise<AgentResponse[]> {
  const reader = new PerformanceReader(projectRoot);
  let scores: Map<string, AgentScore>;
  try { scores = reader.getScores(); } catch { scores = new Map(); }

  return configs.map(config => {
    const score = scores.get(config.id) ?? { ...DEFAULT_SCORE, agentId: config.id };
    return {
      id: config.id,
      provider: config.provider,
      model: config.model,
      preset: config.preset,
      native: config.native ?? false,
      skills: config.skills,
      scores: {
        accuracy: score.accuracy,
        uniqueness: score.uniqueness,
        reliability: score.reliability,
        dispatchWeight: reader.getDispatchWeight(config.id),
        signals: score.totalSignals,
        agreements: score.agreements,
        disagreements: score.disagreements,
        hallucinations: score.hallucinations,
      },
    };
  });
}
