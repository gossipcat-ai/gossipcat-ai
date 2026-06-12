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
  /**
   * Auto-verify stamp written by the consensus-auto-verify pipeline when the
   * `GOSSIP_CONSENSUS_AUTO_VERIFY_UNVERIFIED` flag is enabled. Present ONLY on
   * findings with `tag === 'unverified'` that the verifier attempted to
   * resolve. The `tag` itself remains `'unverified'` regardless of verdict —
   * see spec docs/superpowers/specs/2026-05-21-consensus-auto-verify-design.md.
   */
  autoVerify?: {
    attempted: true;
    verdict: 'confirmed' | 'refuted' | 'inconclusive';
    evidence: string;
    dispatchedAt: string;
    durationMs: number;
  };
}

/** A new finding discovered during cross-review */
export interface ConsensusNewFinding {
  agentId: string;
  finding: string;
  evidence: string;
  confidence: number;
  /**
   * Stable ID for this new finding in the format `<consensusId>:new:<agentId>:<counter>`.
   * Always set on newly synthesized reports. Optional for back-compat with reports
   * persisted before this field was introduced.
   */
  findingId?: string;
  /** Peer finding this extends, e.g. "gemini-reviewer:f1". Set only on chained extensions. */
  parentFindingId?: string;
  /** The extension's own severity — may differ from (escalate) the parent's. */
  severity?: 'critical' | 'high' | 'medium' | 'low';
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
  /** Optional category volunteered by the reviewer in the cross-review JSON.
   *  Validated against `VALID_CATEGORIES` in `parseCrossReviewResponse`; any value
   *  outside the 13-key allowlist is silently dropped to undefined. */
  category?: string;
  /** For action:"new" chained extensions — the peer finding being extended. */
  parentFindingId?: string;
  /** For action:"new" chained extensions — the extension's own severity. */
  severity?: 'critical' | 'high' | 'medium' | 'low';
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
  /**
   * Agents whose raw output contained ZERO `<agent_finding>` tags (the strict
   * parser saw no tags at all). Surfaces the same silent dropout that
   * `consensus-engine.ts:917` logs to stderr, but in-band so the
   * `gossip_collect` tool response and the dashboard JSON payload can
   * highlight it. Capped at the first 5 `originalAgentId`s for compactness —
   * any agents past that quota are counted via `zeroTagOverflow`. Populated
   * only when `zeroTagAgents.length > 0`; clean rounds keep both fields
   * undefined.
   */
  zeroTagAgents?: string[];
  /** Count of zero-tag agents past the 5-entry `zeroTagAgents` cap. */
  zeroTagOverflow?: number;
  /**
   * Fail-loud warnings drained from the round's `RoundContext.warnings` at
   * synthesis (spec §6.1). Populated only when the round carried a
   * RoundContext with at least one warning; clean rounds keep it undefined.
   * Surfaced in the gossip_collect tool response (PR-A) and the dashboard
   * (PR-B). Append-only — mirrors the producer order, no dedup.
   */
  warnings?: import('./round-context').RoundWarning[];
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
    | 'consensus_coverage_degraded'
    /**
     * Relay-worker `resolutionRoots` plumbing gap (spec
     * docs/specs/2026-04-29-relay-worker-resolution-roots.md, Path 2). When a
     * relay-routed agent records `hallucination_caught` whose finding text
     * matches the "files not present / empty diff / cannot read" pattern AND
     * the consensus round was dispatched with `resolutionRoots`, the signal is
     * rewritten from `hallucination_caught` to `transport_failure` BEFORE
     * persisting to `agent-performance.jsonl`. `transport_failure` is excluded
     * from accuracy / uniqueness / circuit-breaker arithmetic — it tracks
     * separately as `AgentScore.transport_failure_count`.
     */
    | 'transport_failure'
    /**
     * Native worktree isolation gap (spec
     * docs/specs/2026-05-20-native-worktree-isolation-fix.md). Emitted by the
     * relay-side detector in apps/cli/src/handlers/worktree-isolation-detection.ts
     * when an `Agent(isolation:"worktree")` dispatch leaves the parent checkout
     * with moved HEAD or new dirty paths — i.e. the native subagent wrote to
     * the parent checkout instead of its isolated worktree. Detection-only;
     * no automatic recovery.
     */
    | 'worktree_isolation_failed'
    /**
     * Operational per-finding signal recorded for each UNVERIFIED finding that
     * the consensus auto-verify pipeline attempted to resolve. Carries
     * `findingId` and `evidence` in the
     * `auto_verify_attempted:<verdict>:<durationMs>ms` shape — DISPLAY ONLY;
     * downstream consumers MUST back-join to `finding.autoVerify`. See
     * docs/superpowers/specs/2026-05-21-consensus-auto-verify-design.md. No-op
     * for scoring.
     */
    | 'auto_verify_attempted'
    /**
     * One-shot round-level signal emitted when the auto-verify feature flag is
     * ON but the engine could not run — `verifierDispatch` is unwired, the
     * operator override names a missing/unsuitable agent, or the team has no
     * suitable verifier. Closed `<reason>` union documented at the spec.
     * No-op for scoring.
     */
    | 'auto_verify_skipped_misconfigured';
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
  /**
   * Modality of the claim that produced this signal, from Stage 2
   * premise-verification. Absent on legacy / non-premise signals — scored
   * as `'asserted'` for back-compat. See
   * `docs/specs/2026-04-22-premise-verification-stage-2.md` §Signal integration.
   */
  modality?: 'asserted' | 'hedged' | 'vague';
  category?: string;
  findingId?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  claimedSeverity?: 'critical' | 'high' | 'medium' | 'low';
  retractedSignal?: string;
  source?: 'auto' | 'manual';
  evidence: string;
  timestamp: string;
  /**
   * `worktree_isolation_failed` payload fields — populated by the native-worktree
   * isolation detector at apps/cli/src/handlers/worktree-isolation-detection.ts.
   * Optional on the union so other signals don't need to carry them; typed
   * readers (dashboards, gossip_signals consumers) can surface them without a
   * side-channel JSON parse. Closes consensus 68283116-20504c9d:f5.
   */
  head_before?: string | null;
  head_after?: string | null;
  dirty_paths_added?: string[];
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
    | 'citation_fabricated'
    /** Path A relay-lint hardening (docs/specs/2026-04-25-relay-lint-hardening.md):
     * orchestrator paraphrased a consensus-dispatched native agent's result,
     * dropping all `<agent_finding>` tags. Observability-only — never gates. */
    | 'relay_findings_dropped'
    /**
     * Phase A system self-telemetry: round-counter detected that fewer signals
     * were written than findings collected. Observability-only — never blocks.
     * Emitted by the collect handler after consensus report is persisted.
     */
    | 'signal_loss_suspected'
    /**
     * Phase 2 dispatch-prompt warm cache (spec
     * docs/specs/2026-05-18-dispatch-prompt-warm-cache.md). Emitted by
     * apps/cli/src/handlers/dispatch-prompt-cache.ts on LRU eviction,
     * invalidation, or concurrent-dispatch overwrite-race. metadata.reason
     * ∈ {'lru' | 'invalidation' | 'overwrite_race'}. Observability-only.
     */
    | 'dispatch_cache_evicted';
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
export const PERFORMANCE_SIGNAL_NAMES: ReadonlySet<string> = new Set([
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

export const OPERATIONAL_SIGNAL_NAMES: ReadonlySet<string> = new Set([
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
  'transport_failure',
  'worktree_isolation_failed',
  'auto_verify_attempted',
  'auto_verify_skipped_misconfigured',
]);

/**
 * Relay-warning ledger entry written to `.gossip/relay-warnings.jsonl` by
 * `appendRelayWarning` (in `native-tasks.ts`) and by `ConsensusEngine`'s
 * fail-open auto-verify dispatch path. Exported so cli construction sites can
 * inline the writer with a typed payload.
 */
export interface RelayWarningEntry {
  taskId: string;
  agentId: string;
  reason: string;
  resultLength: number;
  suspectedReason: string;
  timestamp: string;
}

export function classifySignal(signalName: string): SignalClass | undefined {
  if (PERFORMANCE_SIGNAL_NAMES.has(signalName)) return 'performance';
  if (OPERATIONAL_SIGNAL_NAMES.has(signalName)) return 'operational';
  return undefined;
}
