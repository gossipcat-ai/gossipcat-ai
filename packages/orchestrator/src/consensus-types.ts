/** A finding tagged by consensus phase */
export interface ConsensusFinding {
  id: string;
  originalAgentId: string;
  finding: string;
  tag: 'confirmed' | 'disputed' | 'unique';
  confirmedBy: string[];
  disputedBy: Array<{
    agentId: string;
    reason: string;
    evidence: string;
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
  action: 'agree' | 'disagree' | 'new';
  agentId: string;       // the reviewing agent
  peerAgentId: string;   // the agent whose finding is being reviewed
  finding: string;
  evidence: string;
  confidence: number;    // 1-5
}

/** Full consensus report */
export interface ConsensusReport {
  agentCount: number;
  rounds: number;        // always 2 for MVP (phase 1 + phase 2)
  confirmed: ConsensusFinding[];
  disputed: ConsensusFinding[];
  unique: ConsensusFinding[];
  newFindings: ConsensusNewFinding[];
  signals: ConsensusSignal[];
  summary: string;       // formatted text report
}

/** Return type for collect() */
export interface CollectResult {
  results: import('./types').TaskEntry[];
  consensus?: ConsensusReport;
}

/** A consensus signal for agent performance tracking */
export interface ConsensusSignal {
  type: 'consensus';
  taskId: string;
  signal: 'agreement' | 'disagreement' | 'unique_confirmed' | 'unique_unconfirmed' | 'new_finding' | 'hallucination_caught';
  agentId: string;
  counterpartId?: string;
  skill?: string;
  outcome?: 'correct' | 'incorrect' | 'unresolved';
  evidence: string;
  timestamp: string;
}
