/**
 * Shared MCP server context — all handlers import this.
 * Single mutable context object avoids passing dozens of parameters.
 */
import { randomUUID } from 'crypto';

export interface NativeTaskInfo {
  agentId: string;
  task: string;
  startedAt: number;
  timeoutMs?: number;
  planId?: string;
  step?: number;
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
  booted: false,
  boot: async () => { throw new Error('boot not initialized'); },
  syncWorkersViaKeychain: async () => {},
  getModules: async () => { throw new Error('getModules not initialized'); },
};

export const NATIVE_TASK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function generateTaskId(): string {
  return randomUUID().slice(0, 8);
}

// Preset-aware importance scores — reviewers value accuracy, implementers value relevance
export function presetScores(preset: string): { relevance: number; accuracy: number; uniqueness: number } {
  switch (preset) {
    case 'reviewer':   return { relevance: 3, accuracy: 5, uniqueness: 4 };
    case 'tester':     return { relevance: 3, accuracy: 4, uniqueness: 4 };
    case 'researcher': return { relevance: 4, accuracy: 3, uniqueness: 5 };
    case 'implementer': return { relevance: 5, accuracy: 3, uniqueness: 2 };
    default:           return { relevance: 3, accuracy: 3, uniqueness: 3 };
  }
}
