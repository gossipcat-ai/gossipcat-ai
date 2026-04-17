/**
 * Shared MCP server context — all handlers import this.
 * Single mutable context object avoids passing dozens of parameters.
 */
import { randomUUID } from 'crypto';
import type { CrossReviewEntry, MainAgent } from '@gossip/orchestrator';

export interface NativeCrossReviewPrompt {
  agentId: string;
  system: string;
  user: string;
}

export interface PendingConsensusRound {
  consensusId: string;
  allResults: any[];  // TaskEntry[]
  relayCrossReviewEntries: CrossReviewEntry[];
  /** Relay agents whose phase-2 cross-review failed (quota / parse / network). Surfaced in the final report. */
  relayCrossReviewSkipped?: Array<{ agentId: string; reason: string }>;
  pendingNativeAgents: Set<string>;
  nativeCrossReviewEntries: CrossReviewEntry[];
  deadline: number;
  createdAt: number;
  /** Cross-review prompts for still-pending native agents. Persisted so /mcp reconnect can re-issue EXECUTE NOW. */
  nativePrompts?: NativeCrossReviewPrompt[];
  /**
   * Post-validation, post-realpath citation resolution roots. Carried from
   * dispatch-time or collect-time (collect-time REPLACES dispatch-time —
   * see #126 spec). Used to seed ConsensusEngineConfig.resolutionRoots at
   * every construction site (collect, relay-cross-review timeout,
   * relay-cross-review arrival, synthesis). Persists across /mcp reconnect
   * via persistPendingConsensus.
   */
  resolutionRoots?: readonly string[];
}

export interface NativeTaskInfo {
  agentId: string;
  task: string;
  startedAt: number;
  timeoutMs?: number;
  planId?: string;
  step?: number;
  utilityType?: 'lens' | 'gossip' | 'summary' | 'session_summary' | 'verify_memory' | 'skill_develop' | 'plan';
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  /** One-time token that must accompany gossip_relay — prevents task-ID spoofing */
  relayToken?: string;
}

export interface NativeResultInfo {
  id: string;
  agentId: string;
  task: string;
  status: 'completed' | 'failed' | 'timed_out';
  result?: string;
  error?: string;
  startedAt: number;
  completedAt: number;
}

export interface McpContext {
  mainAgent: MainAgent;  // assigned in boot(); accessed only after boot completes
  relay: any;
  toolServer: any;
  workers: Map<string, any>;
  keychain: any;
  skillEngine: any;
  nativeTaskMap: Map<string, NativeTaskInfo>;
  nativeResultMap: Map<string, NativeResultInfo>;
  nativeAgentConfigs: Map<string, { model: string; instructions: string; description: string; skills: string[] }>;
  /**
   * Identity registry — agentId → runtime/provider/model. Read by the
   * ToolServer's self_identity tool for relay agents (native agents get
   * the identity block injected directly into their prompt). Mutated at
   * boot AND on every syncWorkersViaKeychain so newly-added agents are
   * visible to self_identity without /mcp reconnect.
   */
  identityRegistry: Map<string, { agent_id: string; runtime: 'native' | 'relay'; provider: string; model: string }>;
  pendingConsensusRounds: Map<string, PendingConsensusRound>;
  /**
   * Dispatch-time resolutionRoots (#126 PR-B) keyed by task_id. Populated
   * from gossip_dispatch's `resolutionRoots` pass-through; consumed by
   * gossip_collect when collect-time input is absent. Collect-time REPLACES
   * dispatch-time per spec (not merges). Entries are deleted on collect to
   * bound memory.
   */
  pendingDispatchResolutionRoots: Map<string, readonly string[]>;
  nativeUtilityConfig: { model: string } | null;
  /** Post-fallback runtime provider actually being used by the orchestrator LLM. */
  mainProvider: string;
  /** Post-fallback runtime model actually being used by the orchestrator LLM. */
  mainModel: string;
  /**
   * Original main_agent values from config.json at boot, BEFORE any fallback.
   * Used by syncWorkersViaKeychain to detect genuine config changes — comparing
   * config.main_agent against the post-fallback `mainProvider`/`mainModel`
   * falsely reports a change every sync for any user whose primary key was
   * missing at boot.
   */
  mainProviderConfig: string;
  mainModelConfig: string;
  /** Actual bound HTTP MCP port (0/null if transport disabled). Set after listen(). */
  httpMcpPort: number | null;
  /** Source of the relay port: 'env' | 'sticky' | 'auto'. Used by gossip_status. */
  relayPortSource: 'env' | 'sticky' | 'auto' | null;
  /** Source of the HTTP MCP port. */
  httpMcpPortSource: 'env' | 'sticky' | 'auto' | null;
  booted: boolean;
  /**
   * True when `doBoot()` ran without a config file and synthesized an empty
   * one (fresh-install / degraded-mode). The dashboard boots with 0 agents
   * in this case — subsequent gossip_setup calls refresh it via
   * ctx.relay.setAgentConfigs, but the dashboard poll interval (5s) still
   * imposes a small latency. Used to surface a user-visible advisory in
   * the gossip_setup response (issue #96).
   */
  bootedInDegradedMode: boolean;
  /**
   * Result of the last syncWorkersViaKeychain() call. Lets callers (e.g.
   * gossip_setup) surface agent-count / error info to the user without
   * having to reach into syncWorkers internals. Issue #96 — dashboard
   * empty-agent-list on fresh install.
   */
  lastSyncResult: { ok: boolean; mergedAgentCount: number; error?: string } | null;
  boot: () => Promise<void>;
  syncWorkersViaKeychain: () => Promise<void>;
  getModules: () => Promise<any>;
}

export const ctx: McpContext = {
  mainAgent: null as unknown as MainAgent,
  relay: null,
  toolServer: null,
  workers: new Map(),
  keychain: null,
  skillEngine: null,
  nativeTaskMap: new Map(),
  nativeResultMap: new Map(),
  nativeAgentConfigs: new Map(),
  identityRegistry: new Map(),
  pendingConsensusRounds: new Map(),
  pendingDispatchResolutionRoots: new Map(),
  nativeUtilityConfig: null,
  mainProvider: 'google',
  mainModel: 'gemini-2.5-pro',
  mainProviderConfig: 'google',
  mainModelConfig: 'gemini-2.5-pro',
  httpMcpPort: null,
  relayPortSource: null,
  httpMcpPortSource: null,
  booted: false,
  bootedInDegradedMode: false,
  lastSyncResult: null,
  boot: async () => { throw new Error('boot not initialized'); },
  syncWorkersViaKeychain: async () => {},
  getModules: async () => { throw new Error('getModules not initialized'); },
};

export const NATIVE_TASK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function generateTaskId(): string {
  return randomUUID().slice(0, 8);
}

export function defaultImportanceScores(): { relevance: number; accuracy: number; uniqueness: number } {
  return { relevance: 3, accuracy: 3, uniqueness: 3 };
}
