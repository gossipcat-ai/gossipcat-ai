/**
 * @gossip/orchestrator — Type definitions for orchestration layer.
 */

/** Configuration for a worker agent */
export interface AgentConfig {
  id: string;
  provider: 'anthropic' | 'openai' | 'google' | 'local';
  model: string;
  preset?: string;
  skills: string[];
}

/** Result of a worker agent completing a sub-task */
export interface TaskResult {
  agentId: string;
  task: string;
  result: string;
  error?: string;
  duration: number;
}

/** A decomposed sub-task with skill requirements and assignment */
export interface SubTask {
  id: string;
  description: string;
  requiredSkills: string[];
  assignedAgent?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

/** A dispatch plan produced by the TaskDispatcher */
export interface DispatchPlan {
  originalTask: string;
  subTasks: SubTask[];
  strategy: 'single' | 'parallel' | 'sequential';
  warnings?: string[];
}

/** A choice option presented to the developer in the chat */
export interface ChatChoice {
  value: string;
  label: string;
  hint?: string;
}

/** Structured chat response — text + optional interactive elements */
export interface ChatResponse {
  /** Main text content */
  text: string;
  /** Optional choices for the developer to pick from */
  choices?: {
    message: string;
    options: ChatChoice[];
    allowCustom?: boolean;  // show "Let me explain..." option
    type?: 'select' | 'confirm' | 'multiselect';
  };
  /** Optional progress indicator */
  status?: 'thinking' | 'working' | 'done' | 'error';
  /** Which agents contributed */
  agents?: string[];
}

/** Normalized LLM response from any provider */
export interface LLMResponse {
  text: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Frontmatter for knowledge files — warmth metadata */
export interface MemoryFrontmatter {
  name: string;
  description: string;
  importance: number;
  lastAccessed: string;
  accessCount: number;
  version?: number;
}

/** A single task outcome stored in tasks.jsonl */
export interface TaskMemoryEntry {
  version: number;
  taskId: string;
  task: string;
  skills: string[];
  lens?: string;
  findings: number;
  hallucinated: number;
  scores: {
    relevance: number;
    accuracy: number;
    uniqueness: number;
  };
  warmth: number;
  importance: number;
  timestamp: string;
}

/** An archived task entry in archive.jsonl */
export interface ArchivedTaskEntry {
  archivedAt: string;
  reason: string;
  warmth: number;
  entry: TaskMemoryEntry;
}

/** Options for write-mode dispatch */
export interface DispatchOptions {
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  scope?: string;
  timeoutMs?: number;
}

/** A planned task with write-mode classification */
export interface PlannedTask {
  agentId: string;
  task: string;
  access: 'read' | 'write';
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  scope?: string;
}

/** A tracked dispatch task with status and result */
export interface TaskEntry {
  id: string;
  agentId: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  skillWarnings?: string[];
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  scope?: string;
  worktreeInfo?: {
    path: string;
    branch: string;
  };
}

// ── TaskGraph Event Types ────────────────────────────────────────────────

export interface TaskCreatedEvent {
  type: 'task.created';
  taskId: string;
  agentId: string;
  task: string;
  skills: string[];
  parentId?: string;
  timestamp: string;
}

export interface TaskCompletedEvent {
  type: 'task.completed';
  taskId: string;
  result: string;
  duration: number;
  timestamp: string;
}

export interface TaskFailedEvent {
  type: 'task.failed';
  taskId: string;
  error: string;
  duration: number;
  timestamp: string;
}

export interface TaskCancelledEvent {
  type: 'task.cancelled';
  taskId: string;
  reason: string;
  duration: number;
  timestamp: string;
}

export interface TaskDecomposedEvent {
  type: 'task.decomposed';
  parentId: string;
  strategy: 'single' | 'parallel' | 'sequential';
  subTaskIds: string[];
  timestamp: string;
}

export interface TaskReferenceEvent {
  type: 'task.reference';
  fromTaskId: string;
  toTaskId: string;
  relationship: 'triggered_by' | 'fixes' | 'follows_up' | 'related_to';
  evidence?: string;
  timestamp: string;
}

export type TaskGraphEvent =
  | TaskCreatedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskDecomposedEvent
  | TaskReferenceEvent;

export interface ReconstructedTask {
  taskId: string;
  agentId: string;
  task: string;
  skills: string[];
  parentId?: string;
  status: 'created' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  duration?: number;
  children?: string[];
  references?: TaskReferenceEvent[];
  createdAt: string;
  completedAt?: string;
}

export interface SyncMeta {
  lastSync: string;
  lastSyncEventCount: number;
}

export interface GossipMessage {
  type: 'gossip';
  batchId: string;
  fromAgentId: string;
  forAgentId: string;
  summary: string;
  timestamp: string;
}
