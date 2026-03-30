import { PerformanceReader, AgentScore } from '@gossip/orchestrator/performance-reader';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface AgentConfigLike {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  skills: string[];
  native?: boolean;
}

interface LastTask {
  task: string;
  timestamp: string;
}

export interface AgentResponse {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  native: boolean;
  skills: string[];
  online: boolean;
  totalTokens: number;
  lastTask: LastTask | null;
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
  consecutiveFailures: 0, circuitOpen: false,
};

interface TaskGraphEntry {
  type: string;
  taskId: string;
  agentId?: string;
  task?: string;
  timestamp?: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface AgentTaskData {
  totalTokens: number;
  lastTask: LastTask | null;
}

function readTaskGraphByAgent(projectRoot: string): Map<string, AgentTaskData> {
  const taskGraphPath = join(projectRoot, '.gossip', 'task-graph.jsonl');
  const result = new Map<string, AgentTaskData>();

  if (!existsSync(taskGraphPath)) return result;

  let lines: string[];
  try {
    lines = readFileSync(taskGraphPath, 'utf-8').trim().split('\n').filter(Boolean);
  } catch {
    return result;
  }

  // First pass: collect task.created events keyed by taskId for task description + agentId
  const created = new Map<string, { agentId: string; task: string; timestamp: string }>();
  // Second pass: collect completed events keyed by taskId for tokens
  const completed = new Map<string, { inputTokens: number; outputTokens: number; timestamp: string }>();

  for (const line of lines) {
    let entry: TaskGraphEntry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === 'task.created' && entry.taskId && entry.agentId && entry.task && entry.timestamp) {
      created.set(entry.taskId, { agentId: entry.agentId, task: entry.task, timestamp: entry.timestamp });
    } else if (entry.type === 'task.completed' && entry.taskId) {
      completed.set(entry.taskId, {
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        timestamp: entry.timestamp ?? '',
      });
    }
  }

  // Aggregate per agent
  for (const [taskId, createdData] of created) {
    const { agentId, task, timestamp } = createdData;
    if (!result.has(agentId)) {
      result.set(agentId, { totalTokens: 0, lastTask: null });
    }
    const agentData = result.get(agentId)!;

    const comp = completed.get(taskId);
    if (comp) {
      agentData.totalTokens += comp.inputTokens + comp.outputTokens;
    }

    // Track latest task by timestamp
    if (!agentData.lastTask || timestamp > agentData.lastTask.timestamp) {
      agentData.lastTask = { task, timestamp };
    }
  }

  return result;
}

export async function agentsHandler(
  projectRoot: string,
  configs: AgentConfigLike[],
  onlineAgents: string[] = [],
): Promise<AgentResponse[]> {
  const reader = new PerformanceReader(projectRoot);
  let scores: Map<string, AgentScore>;
  try { scores = reader.getScores(); } catch { scores = new Map(); }

  const taskDataByAgent = readTaskGraphByAgent(projectRoot);

  return configs.map(config => {
    const score = scores.get(config.id) ?? { ...DEFAULT_SCORE, agentId: config.id };
    const agentTask = taskDataByAgent.get(config.id) ?? { totalTokens: 0, lastTask: null };
    return {
      id: config.id,
      provider: config.provider,
      model: config.model,
      preset: config.preset,
      native: config.native ?? false,
      skills: config.skills,
      online: onlineAgents.includes(config.id),
      totalTokens: agentTask.totalTokens,
      lastTask: agentTask.lastTask,
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
