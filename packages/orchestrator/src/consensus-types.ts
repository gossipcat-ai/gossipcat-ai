/** A finding tagged by consensus phase */
export interface ConsensusFinding {
  id: string;
  /** The per-agent finding identifier `${originalAgentId}:f${perAgentIdx}` as
   * assigned during cross-review prompt assembly. Enables dashboard/signal
   * writeback to resolve the 3-part finding_id format
   * `${consensusId}:${agentId}:fN` against this finding. */
  authorFindingId?: string;
  originalAgentId: string;
  finding: string;
  findingType?: 'finding' | 'suggestion' | 'insight';
  severity?: 'critical' | 'high' | 'medium' | 'low';
  tag: 'confirmed' | 'disputed' | 'unverified' | 'unique';
  confirmedBy: string[];
  disputedBy: Array<{
    agentId: string;
    reason: string;
    evidence: string;
  }>;
  unverifiedBy?: Array<{
    agentId: string;
    reason: string;
  }>;
  confidence: number; // 1-5, averaged from cross-review responses
}

/** A new finding discovered during cross-review */
export interface ConsensusNewFinding {
  agentId: string;
  finding: string;
  evidence: string;
  confidence: number;
}

/** A single cross-review entry from one agent about one peer finding */
export interface CrossReviewEntry {
  action: 'agree' | 'disagree' | 'unverified' | 'new';
  agentId: string;       // the reviewing agent
  peerAgentId: string;   // the agent whose finding is being reviewed
  findingId?: string;    // stable ID from cross-review prompt (e.g., "gemini-reviewer:f1")
  finding: string;
  evidence: string;
  confidence: number;    // 1-5
}

/** Full consensus report */
export interface ConsensusReport {
  agentCount: number;
  rounds: number;        // 2 = cross-review only, 3 = with orchestrator verification
  confirmed: ConsensusFinding[];
  disputed: ConsensusFinding[];
  unverified: ConsensusFinding[];
  unique: ConsensusFinding[];
  insights: ConsensusFinding[];
  newFindings: ConsensusNewFinding[];
  signals: ConsensusSignal[];
  summary: string;       // formatted text report
  /**
   * Relay agents whose cross-review LLM call failed (quota / parse / network).
   * Surfaced so the orchestrator can see when an agent silently dropped from
   * consensus instead of pretending the round was complete.
   */
  relayCrossReviewSkipped?: Array<{ agentId: string; reason: string }>;
  /**
   * Coverage degraded when an agent dispatched to the round produced an empty
   * 0-char response (e.g. Gemini MALFORMED_FUNCTION_CALL). The round still
   * completes but with fewer voices than dispatched; surfaced here so the
   * orchestrator can see silent dropouts at the round level rather than only
   * per-task in collect.ts:178 auto-signals.
   */
  coverageDegraded?: { expected: number; received: number; droppedAgents: string[] };
  /**
   * True when at least one finding received fewer cross-reviewers than the
   * target K (e.g. not enough eligible agents). Set by runSelectedCrossReview.
   */
  partialReview?: boolean;
  /**
   * Cross-review assignments: which reviewer was assigned which findings.
   * Map serialized as Record<reviewerAgentId, findingId[]>.
   */
  crossReviewAssignments?: Record<string, string[]>;
  /**
   * Per-finding coverage: how many cross-reviewers were assigned vs target K.
   * Enables dashboard to show under-reviewed findings.
   */
  crossReviewCoverage?: Array<{ findingId: string; assigned: number; targetK: number }>;
  /**
   * Map of unknown type values (lowercased) → total drop count across all
   * agents in this round. Populated only when the strict parser rejected at
   * least one `<agent_finding>` tag for an invalid `type=` value (e.g.
   * `approval`, `concern`, `risk`, `recommendation`, `confirmed`). Surfaces
   * silent type-drift to the dashboard so you can see WHY a round is empty
   * despite agents producing content.
   */
  droppedFindingsByType?: Record<string, number>;
  /**
   * Per-author parse diagnostics from `parseAgentFindingsStrict` (e.g.
   * HTML_ENTITY_ENCODED_TAGS when an upstream layer HTML-escaped the agent
   * output before the parser saw it). Populated only for agents whose raw
   * output produced at least one diagnostic — clean rounds keep this
   * undefined. The dashboard renders a per-finding-card banner on first
   * occurrence per `(consensusId, agentId, code)` tuple to make silent parse
   * failures loud. Keyed by `originalAgentId`.
   */
  authorDiagnostics?: Record<string, import('./parse-findings').ParseDiagnostic[]>;
}

/** Return type for collect() */
export interface CollectResult {
  results: import('./types').TaskEntry[];
  consensus?: ConsensusReport;
  skillsReady?: number;
  skillLifecycle?: { disabled: string[]; promoted: string[] };
}

/**
 * Signal-class discriminator (PR 5 / Option 5B, 2026-04-21).
 *
 * Coarse partition over all PerformanceSignal rows that is ORTHOGONAL to the
 * existing `type` and `category` axes:
 *   - `performance` — findings-quality signals that participate in agent
 *     scoring: agreement, disagreement, unique_confirmed, unique_unconfirmed,
 *     new_finding, hallucination_caught, impl_*.
 *   - `operational` — lifecycle / telemetry signals that MUST NOT affect
 *     scoring: task_completed, task_tool_turns, format_compliance,
 *     signal_retracted, task_timeout, task_empty, citation_fabricated,
 *     finding_dropped_format, consensus_round_retracted.
 *
 * Optional — missing `signal_class` is explicitly valid (write-forward-only,
 * no historical backfill). Existing category-based filtering remains the
 * authoritative reader path; `signal_class` is a forward-compatible hook for
 * dashboards and future consumers that want the partition without re-deriving
 * it from (type, signal) tuples.
 */
export type SignalClass = 'performance' | 'operational';

/** A consensus signal for agent performance tracking */
export interface ConsensusSignal {
  type: 'consensus';
  /** See `SignalClass` — optional, write-forward-only. */
  signal_class?: SignalClass;
  taskId: string;
  consensusId?: string;
  signal:
    | 'agreement'
    | 'disagreement'
    | 'unverified'
    | 'unique_confirmed'
    | 'unique_unconfirmed'
    | 'new_finding'
    | 'hallucination_caught'
    | 'category_confirmed'
    | 'consensus_verified'
    | 'signal_retracted'
    | 'consensus_round_retracted'
    | 'severity_miscalibrated'
    | 'boundary_escape'
    | 'task_timeout'
    | 'task_empty'
    | 'consensus_coverage_degraded';
  agentId: string;
  counterpartId?: string;
  skill?: string;
  outcome?:
    | 'correct'
    | 'incorrect'
    | 'unresolved'
    | 'fabricated_citation'
    | 'false_negative_claim'
    | 'judge_refuted'
    | 'confirmed_hallucination'
    | 'orchestrator_disputed'
    | 'premise_mismatch';
  category?: string;
  findingId?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  claimedSeverity?: 'critical' | 'high' | 'medium' | 'low';
  retractedSignal?: string;
  source?: 'auto' | 'manual';
  evidence: string;
  timestamp: string;
}

/** Implementation quality signal from verify_write */
export interface ImplSignal {
  type: 'impl';
  /** See `SignalClass` — optional, write-forward-only. */
  signal_class?: SignalClass;
  signal: 'impl_test_pass' | 'impl_test_fail' | 'impl_peer_approved' | 'impl_peer_rejected';
  agentId: string;
  taskId: string;
  source?: 'auto' | 'manual';
  evidence?: string;
  timestamp: string;
}

/** Meta signal from worker-agent telemetry */
export interface MetaSignal {
  type: 'meta';
  /** See `SignalClass` — optional, write-forward-only. */
  signal_class?: SignalClass;
  signal: 'task_completed' | 'task_tool_turns' | 'format_compliance';
  agentId: string;
  taskId: string;
  value?: number;
  /** Additional structured data for signals that carry more than a scalar value */
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Pipeline signal — orchestrator self-telemetry. System-scoped (no agentId
 * required). Separate from MetaSignal (which is agent-scoped per-task) so
 * per-agent aggregation in performance-reader is not corrupted by system
 * events that use the `_system` sentinel. Consensus 2f67418b-e8a74d56.
 */
export interface PipelineSignal {
  type: 'pipeline';
  /** See `SignalClass` — optional, write-forward-only. */
  signal_class?: SignalClass;
  signal:
    | 'dispatch_started'
    | 'relay_received'
    | 'finding_dropped_format'
    | 'synthesis_completed'
    | 'circuit_open_fired'
    | 'skill_injection_skipped'
    | 'signal_retracted'
    | 'citation_fabricated';
  /** Real agentId for agent-scoped events; '_system' for system-scoped events. */
  agentId: string;
  taskId: string;
  consensusId?: string;
  value?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** Union of all performance signal types */
export type PerformanceSignal = ConsensusSignal | ImplSignal | MetaSignal | PipelineSignal;

/**
 * Signal-name → SignalClass classifier (PR 5 / Option 5B).
 *
 * Returns `undefined` for signal names that aren't yet categorised — callers
 * must treat that as "no class", NOT as a default. Keeping ambiguous names
 * undefined avoids committing to a classification before downstream consumers
 * need it. The reader path ignores the field entirely for this PR, so any
 * misclassification here is silent data, not a scoring bug.
 *
 * Categorisation follows docs/specs/ signal-class spec (spec author: Option
 * 5B discriminator, 2026-04-21):
 *   performance:  agreement, disagreement, unique_confirmed, unique_unconfirmed,
 *                 new_finding, hallucination_caught, category_confirmed,
 *                 consensus_verified, and all impl_* signals.
 *   operational:  task_completed, task_tool_turns, format_compliance,
 *                 signal_retracted, task_timeout, task_empty,
 *                 citation_fabricated, finding_dropped_format,
 *                 consensus_round_retracted, unverified.
 *
 * Deliberately conservative: signals not covered by the spec list
 * (severity_miscalibrated, boundary_escape, dispatch_started, relay_received,
 * synthesis_completed, circuit_open_fired, skill_injection_skipped) return
 * `undefined`. This keeps the rollout safe — new callers opt in by updating
 * this map, not by inheriting a guess.
 */
const PERFORMANCE_SIGNAL_NAMES: ReadonlySet<string> = new Set([
  'agreement',
  'disagreement',
  'unique_confirmed',
  'unique_unconfirmed',
  'new_finding',
  'hallucination_caught',
  'category_confirmed',
  'consensus_verified',
  'impl_test_pass',
  'impl_test_fail',
  'impl_peer_approved',
  'impl_peer_rejected',
]);

const OPERATIONAL_SIGNAL_NAMES: ReadonlySet<string> = new Set([
  'task_completed',
  'task_tool_turns',
  'format_compliance',
  'signal_retracted',
  'task_timeout',
  'task_empty',
  'citation_fabricated',
  'finding_dropped_format',
  'consensus_round_retracted',
  'unverified',
]);

export function classifySignal(signalName: string): SignalClass | undefined {
  if (PERFORMANCE_SIGNAL_NAMES.has(signalName)) return 'performance';
  if (OPERATIONAL_SIGNAL_NAMES.has(signalName)) return 'operational';
  return undefined;
}
