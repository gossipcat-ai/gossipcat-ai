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
    bench: {
      state: 'benched' | 'kept-for-coverage' | 'none';
      reason?: 'chronic-low-accuracy' | 'burst-hallucination';
    };
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
  unverifiedBy?: Array<{ agentId: string; reason: string }>;
  confidence: number;
}

export interface ConsensusReport {
  id: string;
  timestamp: string;
  topic?: string;
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
  partialReview?: boolean;
  /**
   * Unknown type values (lowercased) → total drop count. Populated by the
   * strict `<agent_finding>` parser when an agent uses an invented type
   * ("approval", "concern", etc). Surfaces silent type-drift that would
   * otherwise show as a round with 0 findings despite agent output.
   */
  droppedFindingsByType?: Record<string, number>;
  /**
   * Per-author parse diagnostics (e.g. HTML_ENTITY_ENCODED_TAGS). Keyed by
   * `originalAgentId`. Populated only when the strict parser emitted at
   * least one diagnostic for that agent's output. The dashboard renders a
   * banner on affected finding cards so silent parse failures become loud.
   */
  authorDiagnostics?: Record<string, ParseDiagnostic[]>;
}

export type ParseDiagnostic =
  | { code: 'HTML_ENTITY_ENCODED_TAGS'; message: string; entityTagCount: number }
  | { code: 'HTML_ENTITY_MIXED_PAYLOAD'; message: string; rawTagCount: number; entityTagCount: number }
  | { code: 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS'; message: string; matchedTokens: string[] }
  | { code: 'SCHEMA_DRIFT_INVENTED_TYPE_TOKENS'; message: string; matchedTokens: string[] }
  | { code: 'SCHEMA_DRIFT_NESTED_SUBTAGS'; message: string; subtagTypes: string[] };

export interface RoundRetraction {
  consensus_id: string;
  reason: string;
  retracted_at: string;
}

export interface ConsensusReportsData {
  reports: ConsensusReport[];
  totalReports?: number;
  page?: number;
  pageSize?: number;
  /**
   * Consensus round IDs that have been retracted via
   * `gossip_signals({action:'retract', consensus_id, reason})`. The report
   * page renders a banner + strike-through findings when a report's id
   * is in this set.
   */
  retractedConsensusIds?: string[];
  /**
   * Full tombstone rows, preserving duplicates so an admin "retracted
   * rounds" view can show each retraction reason.
   */
  roundRetractions?: RoundRetraction[];
}

export interface MemoryFile {
  filename: string;
  frontmatter: Record<string, string>;
  content: string;
  agentId?: string;
  /**
   * Store the memory originated from. Stamped by the dashboard data hook
   * (`useDashboardData`) when merging the two memory arrays for display.
   * Used as part of the dedupe key so a same-named file in both stores is
   * not silently hidden. Spec: docs/specs/2026-04-17-unified-memory-view.md.
   */
  origin?: 'gossip' | 'native';
}

export interface MemoryData {
  index: string;
  knowledge: MemoryFile[];
  tasks: Record<string, unknown>[];
  fileCount: number;
  cognitiveCount: number;
}

export interface SignalEntry {
  signal: string;
  agentId: string;
  counterpartId?: string;
  taskId?: string;
  consensusId?: string;
  findingId?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  evidence?: string;
  timestamp: string;
}

export interface CitationSnippet {
  file: string;
  line: number;
  snippet: string;
}

export interface FindingDetailSignal {
  signal: string;
  agentId: string;
  counterpartId?: string;
  evidence?: string;
  timestamp: string;
}

export interface FindingDetail {
  consensusId: string;
  finding: {
    id: string;
    authorFindingId?: string;
    originalAgentId: string;
    finding: string;
    findingType: 'finding' | 'suggestion' | 'insight';
    severity?: 'critical' | 'high' | 'medium' | 'low';
    tag: 'confirmed' | 'disputed' | 'unverified' | 'unique' | 'insight' | 'newFinding';
    confirmedBy: string[];
    disputedBy: { agentId: string; reason: string }[];
    confidence: number;
  };
  signals: FindingDetailSignal[];
  citations: CitationSnippet[];
  retracted?: { reason: string; at: string };
}

export type DashboardEvent =
  | { type: 'task_dispatched'; taskId: string; agentId: string }
  | { type: 'task_completed'; taskId: string; agentId: string }
  | { type: 'task_failed'; taskId: string; agentId: string }
  | { type: 'consensus_complete'; taskId: string }
  | { type: 'agent_connected'; agentId: string }
  | { type: 'agent_disconnected'; agentId: string }
  | { type: 'log_lines'; data: { lines: string[] } };
