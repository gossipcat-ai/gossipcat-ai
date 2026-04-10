/** A finding tagged by consensus phase */
export interface ConsensusFinding {
  id: string;
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
}

/** Return type for collect() */
export interface CollectResult {
  results: import('./types').TaskEntry[];
  consensus?: ConsensusReport;
  skillsReady?: number;
  skillLifecycle?: { disabled: string[]; promoted: string[] };
}

/** A consensus signal for agent performance tracking */
export interface ConsensusSignal {
  type: 'consensus';
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
    | 'severity_miscalibrated';
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
    | 'orchestrator_disputed';
  category?: string;
  findingId?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  claimedSeverity?: 'critical' | 'high' | 'medium' | 'low';
  retractedSignal?: string;
  evidence: string;
  timestamp: string;
}

/** Implementation quality signal from verify_write */
export interface ImplSignal {
  type: 'impl';
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
  signal: 'task_completed' | 'task_tool_turns' | 'format_compliance';
  agentId: string;
  taskId: string;
  value?: number;
  /** Additional structured data for signals that carry more than a scalar value */
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** Union of all performance signal types */
export type PerformanceSignal = ConsensusSignal | ImplSignal | MetaSignal;
