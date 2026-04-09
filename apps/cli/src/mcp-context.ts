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
}

export interface NativeTaskInfo {
  agentId: string;
  task: string;
  startedAt: number;
  timeoutMs?: number;
  planId?: string;
  step?: number;
  utilityType?: 'lens' | 'gossip' | 'summary' | 'session_summary' | 'verify_memory';
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
  pendingConsensusRounds: Map<string, PendingConsensusRound>;
  nativeUtilityConfig: { model: string } | null;
  mainProvider: string;
  /** Actual bound HTTP MCP port (0/null if transport disabled). Set after listen(). */
  httpMcpPort: number | null;
  /** Source of the relay port: 'env' | 'sticky' | 'auto'. Used by gossip_status. */
  relayPortSource: 'env' | 'sticky' | 'auto' | null;
  /** Source of the HTTP MCP port. */
  httpMcpPortSource: 'env' | 'sticky' | 'auto' | null;
  booted: boolean;
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
  pendingConsensusRounds: new Map(),
  nativeUtilityConfig: null,
  mainProvider: 'google',
  httpMcpPort: null,
  relayPortSource: null,
  httpMcpPortSource: null,
  booted: false,
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
