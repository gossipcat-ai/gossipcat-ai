/**
 * Shared MCP server context — all handlers import this.
 * Single mutable context object avoids passing dozens of parameters.
 */
import { randomUUID } from 'crypto';
import type { CrossReviewEntry } from '@gossip/orchestrator';

export interface PendingConsensusRound {
  consensusId: string;
  allResults: any[];  // TaskEntry[]
  relayCrossReviewEntries: CrossReviewEntry[];
  pendingNativeAgents: Set<string>;
  nativeCrossReviewEntries: CrossReviewEntry[];
  deadline: number;
  createdAt: number;
}

export interface NativeTaskInfo {
  agentId: string;
  task: string;
  startedAt: number;
  timeoutMs?: number;
  planId?: string;
  step?: number;
  utilityType?: 'lens' | 'gossip' | 'summary' | 'session_summary';
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
  mainAgent: any;
  relay: any;
  toolServer: any;
  workers: Map<string, any>;
  keychain: any;
  skillGenerator: any;
  nativeTaskMap: Map<string, NativeTaskInfo>;
  nativeResultMap: Map<string, NativeResultInfo>;
  nativeAgentConfigs: Map<string, { model: string; instructions: string; description: string }>;
  pendingConsensusRounds: Map<string, PendingConsensusRound>;
  nativeUtilityConfig: { model: string } | null;
  booted: boolean;
  boot: () => Promise<void>;
  syncWorkersViaKeychain: () => Promise<void>;
  getModules: () => Promise<any>;
}

export const ctx: McpContext = {
  mainAgent: null,
  relay: null,
  toolServer: null,
  workers: new Map(),
  keychain: null,
  skillGenerator: null,
  nativeTaskMap: new Map(),
  nativeResultMap: new Map(),
  nativeAgentConfigs: new Map(),
  pendingConsensusRounds: new Map(),
  nativeUtilityConfig: null,
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
