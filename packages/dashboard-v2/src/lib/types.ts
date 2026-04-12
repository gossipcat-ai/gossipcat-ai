export interface OverviewData {
  agentsOnline: number;
  relayCount: number;
  relayConnected: number;
  nativeCount: number;
  consensusRuns: number;
  totalFindings: number;
  confirmedFindings: number;
  totalSignals: number;
  tasksCompleted: number;
  tasksFailed: number;
  avgDurationMs: number;
  lastConsensusTimestamp: string;
  actionableFindings: number;
  hourlyActivity: number[];
}

export interface AgentData {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  native: boolean;
  skills: string[];
  skillSlots: { name: string; enabled: boolean; source: string; mode: 'permanent' | 'contextual'; boundAt: string }[];
  online: boolean;
  totalTokens: number;
  lastTask: { task: string; timestamp: string } | null;
  scores: {
    accuracy: number; uniqueness: number; reliability: number;
    impactScore: number; dispatchWeight: number; signals: number;
    agreements: number; disagreements: number; hallucinations: number;
    consecutiveFailures: number; circuitOpen: boolean;
    // categoryStrengths is an unbounded dispatch-routing accumulator — do not
    // render as a percentage. categoryAccuracy = c / (c + h) is the real ratio.
    categoryStrengths: Record<string, number>;
    categoryAccuracy?: Record<string, number>;
    categoryCorrect?: Record<string, number>;
    categoryHallucinated?: Record<string, number>;
  };
}

export interface TaskItem {
  taskId: string;
  agentId: string;
  task: string;
  result?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running';
  duration?: number;
  timestamp: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TasksData {
  items: TaskItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface ConsensusRun {
  taskId: string;
  timestamp: string;
  agents: string[];
  signals: { signal: string; agentId: string; counterpartId?: string; findingId?: string; evidence?: string }[];
  counts: { agreement: number; disagreement: number; unverified: number; unique: number; hallucination: number; new: number; insights: number };
}

export interface ConsensusData {
  runs: ConsensusRun[];
  /** Total count of real consensus runs (≥2 agents, ≥3 signals) — independent of pagination. */
  totalRuns: number;
  totalSignals: number;
  page: number;
  pageSize: number;
}

export interface ConsensusReportFinding {
  id: string;
  originalAgentId: string;
  finding: string;
  findingType?: 'finding' | 'suggestion' | 'insight';
  severity?: 'critical' | 'high' | 'medium' | 'low';
  tag: string;
  confirmedBy: string[];
  disputedBy?: Array<{ agentId: string; reason: string; evidence: string }>;
  confidence: number;
}

export interface ConsensusReport {
  id: string;
  timestamp: string;
  agentCount: number;
  rounds: number;
  confirmed: ConsensusReportFinding[];
  disputed: ConsensusReportFinding[];
  unverified: ConsensusReportFinding[];
  unique: ConsensusReportFinding[];
  insights: ConsensusReportFinding[];
  newFindings: Array<{ agentId: string; finding: string; evidence: string; confidence: number }>;
  crossReviewAssignments?: Record<string, string[]>;
  crossReviewCoverage?: Array<{ findingId: string; assigned: number; targetK: number }>;
}

export interface ConsensusReportsData {
  reports: ConsensusReport[];
  totalReports?: number;
  page?: number;
  pageSize?: number;
}

export interface MemoryFile {
  filename: string;
  frontmatter: Record<string, string>;
  content: string;
  agentId?: string;
}

export interface MemoryData {
  index: string;
  knowledge: MemoryFile[];
  tasks: Record<string, unknown>[];
  fileCount: number;
  cognitiveCount: number;
}

export type DashboardEvent =
  | { type: 'task_dispatched'; taskId: string; agentId: string }
  | { type: 'task_completed'; taskId: string; agentId: string }
  | { type: 'task_failed'; taskId: string; agentId: string }
  | { type: 'consensus_complete'; taskId: string }
  | { type: 'agent_connected'; agentId: string }
  | { type: 'agent_disconnected'; agentId: string }
  | { type: 'log_lines'; data: { lines: string[] } };
