import { PerformanceReader, AgentScore } from '@gossip/orchestrator/performance-reader';
import { SkillIndex, SkillSlot } from '@gossip/orchestrator/skill-index';
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

export interface ForcedDevelopEntry {
  timestamp: string;
  reason?: string;
}

export type SkillStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'silent_skill'
  | 'insufficient_evidence'
  | 'inconclusive'
  | 'flagged_for_manual_review';

export interface SkillSlotResponse {
  name: string;
  enabled: boolean;
  source: string;
  mode: 'permanent' | 'contextual';
  boundAt: string;
  effectiveness?: number | null;
  status?: SkillStatus;
  inconclusiveStrikes?: number;
  inconclusiveAt?: string;
  forcedDevelops?: ForcedDevelopEntry[];
}

interface SkillFrontmatter {
  effectiveness?: number;
  status?: string;
  inconclusive_strikes?: number;
  inconclusive_at?: string;
}

/** Parse a YAML-like frontmatter block. We avoid pulling a YAML dep and only
 * extract the 4 scalar keys we need. Returns null on any failure. */
function readSkillFrontmatter(
  projectRoot: string,
  agentId: string,
  skillName: string,
): SkillFrontmatter | null {
  try {
    const path = join(projectRoot, '.gossip', 'agents', agentId, 'skills', `${skillName}.md`);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    // Frontmatter must start with --- on the first line.
    if (!raw.startsWith('---')) return null;
    const end = raw.indexOf('\n---', 3);
    if (end === -1) return null;
    const block = raw.slice(3, end);
    const out: SkillFrontmatter = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const key = m[1];
      let value: string = m[2];
      // Strip surrounding quotes if present.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === 'effectiveness') {
        const n = Number(value);
        if (Number.isFinite(n)) out.effectiveness = n;
      } else if (key === 'status') {
        out.status = value;
      } else if (key === 'inconclusive_strikes') {
        const n = Number(value);
        if (Number.isFinite(n)) out.inconclusive_strikes = n;
      } else if (key === 'inconclusive_at') {
        out.inconclusive_at = value;
      }
    }
    return out;
  } catch {
    return null;
  }
}

interface ForcedDevelopRow {
  agent_id?: string;
  agentId?: string;
  category?: string;
  timestamp?: string;
  reason?: string;
}

/** Normalize a category key so "input_validation" and "input-validation" match. */
function normalizeCategory(s: string): string {
  return s.replace(/[-_]/g, '').toLowerCase();
}

function readForcedDevelops(
  projectRoot: string,
  agentId: string,
  category: string,
): ForcedDevelopEntry[] {
  try {
    const path = join(projectRoot, '.gossip', 'forced-skill-develops.jsonl');
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    const target = normalizeCategory(category);
    const out: ForcedDevelopEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row: ForcedDevelopRow;
      try { row = JSON.parse(line); } catch { continue; }
      const rowAgent = row.agent_id ?? row.agentId;
      if (rowAgent !== agentId) continue;
      if (!row.category || normalizeCategory(row.category) !== target) continue;
      if (!row.timestamp) continue;
      out.push({ timestamp: row.timestamp, reason: row.reason });
    }
    return out;
  } catch {
    return [];
  }
}

export interface AgentResponse {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  native: boolean;
  skills: string[];
  skillSlots: SkillSlotResponse[];
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
    unverifiedsEmitted: number;
    unverifiedsReceived: number;
    bench: {
      state: 'benched' | 'kept-for-coverage' | 'none';
      reason?: 'chronic-low-accuracy' | 'burst-hallucination';
    };
  };
}

const DEFAULT_SCORE: AgentScore = {
  agentId: '', accuracy: 0.5, uniqueness: 0.5, reliability: 0.5, impactScore: 0.5,
  totalSignals: 0, agreements: 0, disagreements: 0, uniqueFindings: 0, hallucinations: 0,
  unverifiedsEmitted: 0, unverifiedsReceived: 0,
  weightedHallucinations: 0,
  consecutiveFailures: 0, circuitOpen: false, categoryStrengths: {},
  categoryCorrect: {}, categoryHallucinated: {}, categoryAccuracy: {},
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

  let skillIndex: SkillIndex | null = null;
  try { skillIndex = new SkillIndex(projectRoot); } catch { /* skill index unavailable */ }

  const allIds = configs.map(c => c.id);

  return configs.map(config => {
    const score = scores.get(config.id) ?? { ...DEFAULT_SCORE, agentId: config.id };
    const agentTask = taskDataByAgent.get(config.id) ?? { totalTokens: 0, lastTask: null };

    const categories = Object.keys({ ...score.categoryCorrect, ...score.categoryHallucinated });
    const benchResult = reader.isBenched(config.id, categories, allIds);
    const benchState: 'benched' | 'kept-for-coverage' | 'none' =
      benchResult.benched ? 'benched'
      : benchResult.safeguardBlocked ? 'kept-for-coverage'
      : 'none';
    const bench = {
      state: benchState,
      reason: benchResult.reason as 'chronic-low-accuracy' | 'burst-hallucination' | undefined,
    };

    let skillSlots: SkillSlotResponse[] = [];
    try {
      if (skillIndex) {
        skillSlots = skillIndex.getAgentSlots(config.id).map((slot: SkillSlot) => {
          const fm = readSkillFrontmatter(projectRoot, config.id, slot.skill);
          const forced = readForcedDevelops(projectRoot, config.id, slot.skill);
          const response: SkillSlotResponse = {
            name: slot.skill,
            enabled: slot.enabled,
            source: slot.source,
            mode: slot.mode ?? 'permanent',
            boundAt: slot.boundAt,
          };
          if (fm) {
            if (fm.effectiveness !== undefined) response.effectiveness = fm.effectiveness;
            if (fm.status !== undefined) response.status = fm.status as SkillStatus;
            if (fm.inconclusive_strikes !== undefined) response.inconclusiveStrikes = fm.inconclusive_strikes;
            if (fm.inconclusive_at !== undefined) response.inconclusiveAt = fm.inconclusive_at;
          }
          if (forced.length > 0) response.forcedDevelops = forced;
          return response;
        });
      }
    } catch { /* return empty on error */ }

    return {
      id: config.id,
      provider: config.provider,
      model: config.model,
      preset: config.preset,
      native: config.native ?? false,
      skills: config.skills,
      skillSlots,
      online: onlineAgents.includes(config.id),
      totalTokens: agentTask.totalTokens,
      lastTask: agentTask.lastTask,
      scores: {
        accuracy: score.accuracy,
        uniqueness: score.uniqueness,
        reliability: score.reliability,
        impactScore: score.impactScore ?? 0.5,
        dispatchWeight: reader.getDispatchWeight(config.id),
        signals: score.totalSignals,
        agreements: score.agreements,
        disagreements: score.disagreements,
        hallucinations: score.hallucinations,
        unverifiedsEmitted: score.unverifiedsEmitted ?? 0,
        unverifiedsReceived: score.unverifiedsReceived ?? 0,
        consecutiveFailures: score.consecutiveFailures ?? 0,
        circuitOpen: score.circuitOpen ?? false,
        bench,
        // categoryStrengths is an UNBOUNDED severity-weighted accumulator used
        // for dispatch routing (severity × decay × 0.15 per confirmed signal),
        // not a [0,1] ratio. The dashboard must NOT render it as a percentage —
        // it should render categoryAccuracy (c / (c + h)) which is a real ratio.
        // See performance-reader.ts:357 (increment) vs :496-505 (accuracy).
        categoryStrengths: score.categoryStrengths ?? {},
        categoryAccuracy: score.categoryAccuracy ?? {},
        // Forward raw counts so the dashboard can render "100% (3/3)" and
        // distinguish a sparse-but-clean category from a high-volume clean
        // one. categoryAccuracy already drops categories with fewer than
        // MIN_CATEGORY_N signals, but the counts let the UI surface them
        // as dimmed "sparse" rows instead of hiding them silently.
        categoryCorrect: score.categoryCorrect ?? {},
        categoryHallucinated: score.categoryHallucinated ?? {},
      },
    };
  });
}
