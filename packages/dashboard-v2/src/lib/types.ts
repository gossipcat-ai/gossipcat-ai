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
  skillVerdictSummary?: {
    pending: number;
    passed: number;
    failed: number;
    silent_skill: number;
    insufficient_evidence: number;
    inconclusive: number;
  };
  droppedFindingTypeCounts?: Record<string, number>;
}

export interface FleetTrendPoint {
  day: string;
  agentId: string;
  accuracy: number;
  signals: number;
}

export interface FleetTrendResponse {
  days: number;
  points: FleetTrendPoint[];
}

/* ── 24h signal-activity histogram (flat signal log, not consensus runs) ── */
export interface SignalActivityResponse {
  agents: { id: string; buckets: number[] }[];
  total: number;
  generatedAt: string;
}

/* ── Step 9.5 — skills + post-bind effectiveness curves ───────────────── */
// SkillCurvePoint, SkillEffectivenessEntry, SkillsApiResponse, SkillVerdict,
// and SkillStatus are canonical in @gossip/types/skills. Re-exported here for
// backward compat so all existing `import type { ... } from '@/lib/types'`
// call sites continue to compile without changes.
import type { SkillStatus as _SkillStatus } from '@gossip/types';
export type { SkillCurvePoint, SkillEffectivenessEntry, SkillsApiResponse, SkillVerdict, SkillStatus } from '@gossip/types';
// Alias in local scope so SkillSlot.status below resolves correctly.
type SkillStatus = _SkillStatus;

export interface ForcedDevelopEntry {
  timestamp: string;
  reason?: string;
}

export interface SkillSlot {
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
  /** ISO timestamp from skill frontmatter `bound_at` field (diverges from boundAt on redevelop). */
  boundAtFrontmatter?: string;
  /** correct + hallucinated signals since frontmatter bound_at, for MIN_EVIDENCE gate progress. */
  postBindSignals?: number;
  /** The MIN_EVIDENCE gate threshold. */
  minEvidence?: number;
}

export interface AgentData {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  native: boolean;
  skills: string[];
  skillSlots: SkillSlot[];
  online: boolean;
  totalTokens: number;
  lastTask: { task: string; timestamp: string } | null;
  scores: {
    accuracy: number; uniqueness: number; reliability: number;
    /** Real task-completion rate: completed / (completed + failed). Null when
     * no terminal tasks exist. Use this for the "Reliability" bar on all
     * dashboard surfaces — score.reliability is a composite formula kept only
     * for internal dispatch-weight arithmetic. */
    taskCompletionRate: number | null;
    impactScore: number; dispatchWeight: number; signals: number;
    agreements: number; disagreements: number; hallucinations: number; uniqueFindings: number;
    unverifiedsEmitted?: number; unverifiedsReceived?: number;
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
  retracted?: boolean;
  retractedAt?: string;
  retractionReason?: string;
}

export interface ConsensusData {
  runs: ConsensusRun[];
  /** Total count of real consensus runs (≥2 agents, ≥3 signals) — independent of pagination. */
  totalRuns: number;
  totalSignals: number;
  page: number;
  pageSize: number;
  /** Consensus round IDs that have been retracted via gossip_signals action:"retract". */
  retractedConsensusIds?: string[];
  /** Full tombstone rows preserving duplicates for admin "retracted rounds" views. */
  roundRetractions?: Array<{ consensus_id: string; reason: string; retracted_at: string }>;
}

/**
 * Aggregated peer relationship between two agents, derived client-side from
 * the consensus signal stream. Each pair is keyed by the alphabetically-sorted
 * `agentId` pair joined with `::` (see `peerKey()` in lib/peer-relationships.ts).
 *
 * Powers Phase 1b's AgentNetworkGraph edge encoding:
 *   confirmed-dominant pair  → `peer-trust` edge (green, solid)
 *   disputed-present pair    → `peer-mixed` edge (amber, solid-with-dashes)
 *   any hallucinations       → `peer-catch` edge (red, dashed)
 */
export interface PeerRelationship {
  /** Distinct consensus rounds (by taskId) where this pair both appeared. */
  rounds: number;
  /** Count of `agreement` + `unique_confirmed` signals between the pair. */
  confirmed: number;
  /** Count of `disagreement` signals between the pair. */
  disputed: number;
  /** Count of `hallucination_caught` signals between the pair (symmetric: either direction). */
  hallucinationsCaught: number;
  /** ISO timestamp of the most recent consensus round containing any signal for this pair. */
  lastInteraction: string;
}

/** Map from `peerKey(a, b)` → aggregated relationship. Order-independent. */
export type PeerRelationshipMap = Map<string, PeerRelationship>;

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
  newFindings: Array<{ agentId: string; finding: string; evidence: string; confidence: number; findingId?: string; parentFindingId?: string; severity?: 'critical' | 'high' | 'medium' | 'low' }>;
  crossReviewAssignments?: Record<string, string[]>;
  crossReviewCoverage?: Array<{ findingId: string; assigned: number; targetK: number }>;
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
  /**
   * Agents whose raw output contained zero `<agent_finding>` tags. Mirrors
   * the orchestrator `ConsensusReport.zeroTagAgents` field so dashboard JSON
   * parsing preserves the in-band signal. Capped at 5 entries; overflow is
   * carried separately in `zeroTagOverflow`.
   */
  zeroTagAgents?: string[];
  /** Count of zero-tag agents past the 5-entry `zeroTagAgents` cap. */
  zeroTagOverflow?: number;
  /**
   * Fail-loud round warnings drained from the round's RoundContext (spec
   * 2026-06-11-round-context-fail-loud.md §4). Append-only, no dedup — the
   * array keeps every instance; the report card aggregates visually by code
   * with a per-code count while preserving per-instance messages in a tooltip.
   */
  warnings?: RoundWarning[];
}

/** One fail-loud warning entry. Mirrors orchestrator `RoundWarning`. */
export interface RoundWarning {
  code: string;
  message: string;
  agentId?: string;
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

/* ── Step 7 — Consensus Flow ─────────────────────────────────────────── */

export type ConsensusFlowFamily = 'sonnet' | 'gemini' | 'opus' | 'haiku' | 'other';

export type ConsensusFlowVerdict = 'confirmed' | 'disputed' | 'unverified' | 'unique';

export interface ConsensusFlowEdge {
  from: { family: ConsensusFlowFamily; agentCount: number };
  to: { verdict: ConsensusFlowVerdict; count: number };
  /** count / totalFindings, in [0, 1]. */
  weight: number;
}

export interface ConsensusFlowResponse {
  consensusId: string;
  timestamp: string;
  agentCount: number;
  modelFamilyToFindings: Array<{
    family: ConsensusFlowFamily;
    agentIds: string[];
    agentCount: number;
  }>;
  familyToOutcome: ConsensusFlowEdge[];
  summary: {
    totalFindings: number;
    confirmed: number;
    disputed: number;
    unverified: number;
    unique: number;
    newFindings: number;
  };
  crossReviewAssignments?: Record<string, string[]>;
  crossReviewCoverage?: Array<{ findingId: string; assigned: number; targetK: number }>;
  partialReview?: boolean;
  coverageDegraded?: { expected: number; received: number; droppedAgents: string[] };
}

export interface ViolationEntry {
  taskId: string;
  agentId: string;
  preSha: string;
  postSha: string;
  detectedAt: string;   // ISO-8601
  commits: string[];    // "sha subject" strings
}

export interface ViolationsResponse {
  items: ViolationEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export type DashboardEvent =
  | { type: 'task_dispatched'; taskId: string; agentId: string }
  | { type: 'task_completed'; taskId: string; agentId: string }
  | { type: 'task_failed'; taskId: string; agentId: string }
  | { type: 'consensus_complete'; taskId: string }
  | { type: 'agent_connected'; agentId: string }
  | { type: 'agent_disconnected'; agentId: string }
  | { type: 'log_lines'; data: { lines: string[] } };
