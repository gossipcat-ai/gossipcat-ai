/**
 * @gossip/types - Orchestrator-specific types
 *
 * Types used by the orchestrator and agents for task planning and state sharing.
 */

/**
 * The current state of an agent's session.
 */
export enum SessionState {
  THINKING = 'THINKING',
  CODING = 'CODING',
  TESTING = 'TESTING',
  REFACTORING = 'REFACTORING',
  IDLE = 'IDLE',
  DONE = 'DONE',
  ERROR = 'ERROR',
}

/**
 * The state of a plan execution.
 */
export enum PlanState {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * Represents a single step in a plan.
 */
export interface PlanStep {
  id: string;
  description: string;
  state: 'PENDING' | 'DONE' | 'SKIPPED';
}

/**
 * Represents the execution plan for an agent.
 */
export interface Plan {
  agentId: string;
  state: PlanState;
  steps: PlanStep[];
}

/**
 * A gossip message about an agent's session state.
 */
export interface SessionGossipEntry {
  sessionId: string;
  agentId: string;
  state: SessionState;
  plan: Plan;
  timestamp: number;
}

/**
 * A snapshot of the state of all known sessions.
 * The key is the sessionId.
 */
export type SessionGossipSnapshot = Record<string, Omit<SessionGossipEntry, 'sessionId' | 'timestamp'>>;
