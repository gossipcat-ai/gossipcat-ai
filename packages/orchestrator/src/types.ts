/**
 * @gossip/orchestrator — Type definitions for orchestration layer.
 */

/** Configuration for a worker agent */
export interface AgentConfig {
  id: string;
  provider: 'anthropic' | 'openai' | 'deepseek' | 'google' | 'local';
  model: string;
  /** Custom API base URL for OpenAI-compatible endpoints (e.g. DeepSeek).
   *  When omitted, OpenAIProvider defaults to https://api.openai.com/v1.
   *  Carried from config through configToAgentConfigs (issue #522). */
  base_url?: string;
  /** Keychain SERVICE NAME to resolve this agent's API key from. Defaults to
   *  `provider` when omitted — byte-identical to pre-#522 behavior. Lets two
   *  OpenAI-compatible agents read different keychain entries. This is a service
   *  NAME, never the key itself (the key stays in the OS keychain). Validated
   *  against /^[a-zA-Z0-9_-]{1,32}$/ in validateConfig (issue #522). */
  key_ref?: string;
  /** Per-agent override for the WorkerAgent tool-turn budget. When omitted,
   *  WorkerAgent falls back to the MAX_TOOL_TURNS default (15). Lets a
   *  slow-reasoning agent (e.g. deepseek-challenger at 60-74s/turn, 40-55
   *  turns per cross-review) get more turns without raising the global cap.
   *  Validated in validateConfig as an integer in [1, 100]; carried through
   *  configToAgentConfigs. */
  maxToolTurns?: number;
  /** Freeform role description — replaces preset. e.g. "ui-architect", "security-auditor" */
  role?: string;
  /** @deprecated Use role instead */
  preset?: string;
  skills: string[];
  /** If true, agent is a native Claude Code subagent (.claude/agents/*.md).
   *  Dispatched via Claude Code's Agent tool instead of the gossipcat relay.
   *  Results are fed back via gossip_relay for consensus/gossip. */
  native?: boolean;

  // ─── HTTP File Bridge (spec 2026-04-14) ───────────────────────────────────
  // Wired by PR-C (dispatch-pipeline). Defined here so AgentConfig consumers
  // that read these fields typecheck cleanly even before the pipeline branch
  // lands. See docs/specs/2026-04-14-http-file-bridge.md §Config schema.

  /** Enable HTTP file bridge for this agent. */
  enableHttpBridge?: boolean;

  /** Bridge mode: "read" | "scoped" | "worktree". Defaults to "read". */
  bridgeWriteMode?: 'read' | 'scoped' | 'worktree';

  /** Path scope relative to project root. Defaults to project root (full access). */
  bridgeScope?: string;

  /** If true, bind bridge to tunnel-accessible interface instead of 127.0.0.1 only.
   *  Requires TLS + cert-pinning to be configured. */
  bridgeRemoteAccess?: boolean;
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
    /** Set when the model-produced arguments string was not valid JSON. The tool must NOT be executed; feed the error back to the model. */
    argumentsParseError?: string;
    /** The raw arguments string that failed to parse (first 200 chars). Included in the error message fed back to the model. */
    rawArguments?: string;
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
  /**
   * Explicit dispatch task type. When omitted, the dispatch pipeline calls
   * `inferTaskType(task, writeMode)` to derive one before calling loadSkills.
   * Callers that already know the type (e.g. internal orchestrator paths)
   * should pass it through to avoid re-inference.
   */
  taskType?: 'review' | 'implement' | 'research';
  /**
   * Worktree paths to scope relay-agent tool calls against. When present and
   * the dispatched worker is a `WorkerAgent` (relay), `resolutionRoots[0]`
   * is plumbed via `toolServer.assignRoot` so file_read/file_grep/git_diff
   * etc. resolve against the worktree instead of `projectRoot`.
   *
   * Spec: docs/specs/2026-04-29-relay-worker-resolution-roots.md (Path 1).
   */
  resolutionRoots?: readonly string[];
  /**
   * Local absolute image file paths (PNG/JPEG) to attach to the initial user
   * message for vision-capable relay providers. Read + base64-encoded + guarded
   * (max 4 images, ≤4 MB each, magic-byte sniff) by the worker via
   * `resolveTaskImages`. Non-vision providers ignore the field with a notice.
   * When omitted, the worker auto-detects up to 4 absolute PNG/JPEG paths from
   * the task text. See task-images.ts.
   */
  images?: string[];
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
  lastEventAt?: number;
  /** Whether the agent called memory_query at least once during task execution. */
  memoryQueryCalled?: boolean;
  /**
   * Spec docs/specs/2026-04-29-relay-worker-resolution-roots.md — per-task
   * worktree paths used by relay agents (toolServer.assignRoot) and
   * persisted on RelayTaskRecord for cross-reconnect audit visibility.
   */
  resolutionRoots?: readonly string[];
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
  /** Whether the agent called memory_query during this task (compliance auditing). */
  memoryQueryCalled?: boolean;
  timestamp: string;
}

export interface TaskFailedEvent {
  type: 'task.failed';
  taskId: string;
  error: string;
  duration: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Whether the agent called memory_query before failing (compliance auditing). */
  memoryQueryCalled?: boolean;
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
  mode?: 'cognitive';
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
