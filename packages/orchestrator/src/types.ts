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
  /** If true, agent is a native Claude Code subagent (.claude/agents/*.md).
   *  Dispatched via Claude Code's Agent tool instead of the gossipcat relay.
   *  Results are fed back via gossip_relay for consensus/gossip. */
  native?: boolean;
}

/** Result of a worker agent completing a sub-task */
export interface TaskResult {
  agentId: string;
  task: string;
  result: string;
  error?: string;
  duration: number;
}

/** Structured result from WorkerAgent.executeTask with token accounting */
export interface TaskExecutionResult {
  result: string;
  inputTokens: number;
  outputTokens: number;
}

/** Emitted during plan execution for UI progress tracking */
export interface TaskProgressEvent {
  taskIndex: number;
  totalTasks: number;
  agentId: string;
  taskDescription: string;
  status: 'init' | 'start' | 'progress' | 'done' | 'error' | 'finish';
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  currentTool?: string;
  turn?: number;
  result?: string;
  error?: string;
  agents?: Array<{ agentId: string; task: string }>;
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
  planId?: string;
  step?: number;
  lens?: string;  // NEW — focus lens from adaptive team intelligence
  consensus?: boolean;  // Enable cross-review consensus
}

/** Result of analyzing skill overlap between co-dispatched agents */
export interface OverlapResult {
  hasOverlaps: boolean;
  agents: Array<{ id: string; preset: string; skills: string[] }>;
  sharedSkills: string[];
  pairs: Array<{ agentA: string; agentB: string; shared: string[]; type: 'redundant' | 'complementary' }>;
}

/** A focus lens assigned to an agent for a specific dispatch */
export interface LensAssignment {
  agentId: string;
  focus: string;
  avoidOverlap: string;
}

/** Session gossip entry — accumulated across all dispatches */
export interface SessionGossipEntry {
  agentId: string;
  taskSummary: string;
  timestamp: number;
}

/** Stored plan state for chain threading */
export interface PlanState {
  id: string;
  task: string;
  strategy: string;
  steps: Array<{
    step: number;
    agentId: string;
    task: string;
    writeMode?: string;
    scope?: string;
    result?: string;
    completedAt?: number;
  }>;
  createdAt: number;
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
  planId?: string;
  planStep?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
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
  inputTokens?: number;
  outputTokens?: number;
  timestamp: string;
}

export interface TaskFailedEvent {
  type: 'task.failed';
  taskId: string;
  error: string;
  duration: number;
  inputTokens?: number;
  outputTokens?: number;
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
  inputTokens?: number;
  outputTokens?: number;
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

// ── Cognitive Orchestration Types ─────────────────────────────────────────

/** A parsed tool call from LLM response */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Result of executing a tool via ToolRouter */
export interface ToolResult {
  text: string;
  agents?: string[];
  choices?: ChatResponse['choices'];
}

/** Options for MainAgent.handleMessage() */
export interface HandleMessageOptions {
  /** 'cognitive' = intent detection (default), 'decompose' = old flow */
  mode?: 'cognitive' | 'decompose';
}

// ── Project Team Init Types ──────────────────────────────────────────────

/** Project metadata stored in .gossip/config.json */
export interface ProjectConfig {
  description: string;
  archetype: string;
  initialized: string; // ISO timestamp
}

/** An archetype role definition */
export interface ArchetypeRole {
  preset: string;
  focus: string;
}

/** Signal patterns for archetype detection */
export interface ArchetypeSignals {
  keywords: string[];
  files: string[];
  packages: string[];
}

/** A single archetype from the catalog */
export interface Archetype {
  name: string;
  description: string;
  roles: ArchetypeRole[];
  signals: ArchetypeSignals;
}

/** Action for team modification */
export interface TeamChangeAction {
  action: 'add' | 'remove' | 'modify';
  agentId?: string;
  config?: Partial<AgentConfig>;
  reason?: string;
}

/** Detected project signals from directory scan */
export interface ProjectSignals {
  language?: string;
  framework?: string;
  dependencies: string[];
  directories: string[];
  files: string[];
}

/** Minimum number of completed agent results needed to run consensus cross-review */
export const MIN_AGENTS_FOR_CONSENSUS = 2;
