/**
 * Memory-query attribution buffer.
 *
 * When a native agent calls memory_query / gossip_remember during a dispatched
 * task, the relay router sees the RPC_REQUEST and records (agent_id, ts) here.
 * On task completion (gossip_relay), the native-tasks handler queries this
 * buffer with the dispatch window [startedAt, now] to populate
 * `memoryQueryCalled` on the TaskGraph entry.
 *
 * This is Option 1 from project_memory_query_observability.md — relay-side
 * attribution. Avoids modifying the gossip_relay MCP schema or injecting
 * markers into agent prompts.
 *
 * Bookkeeping:
 *   - Per-agent ring of recent calls (cap 256 entries each).
 *   - Anything older than 5 minutes is pruned on every insert (cheap O(n)
 *     because arrays stay small under the 256-cap).
 *
 * The buffer is in-memory only. Across /mcp reconnects the relay process
 * survives (it's the parent), so entries persist; if the relay itself
 * restarts, in-flight tasks lose attribution — acceptable since the task
 * itself would also be in flux.
 */

/** Tools whose invocation should be attributed as a memory query. */
export const MEMORY_QUERY_TOOLS: ReadonlySet<string> = new Set([
  'gossip_remember',
  'memory_query',
]);

/** Cap per agent. Memory queries are infrequent (skill says one per task is the floor). */
const PER_AGENT_CAP = 256;

/** Anything older than this is discarded on insert. 5 minutes covers any realistic native task. */
const RETENTION_MS = 5 * 60 * 1000;

interface Entry {
  tool: string;
  ts: number;
}

const buffer: Map<string, Entry[]> = new Map();

/**
 * Record that `agent_id` invoked `tool_name` at `ts` (default: now).
 * Caller is responsible for filtering by MEMORY_QUERY_TOOLS — recording a
 * non-memory-query tool is a no-op (we still filter here defensively).
 */
export function recordMemoryQueryAttribution(agent_id: string, tool_name: string, ts?: number): void {
  if (!MEMORY_QUERY_TOOLS.has(tool_name)) return;
  if (!agent_id) return;

  const now = ts ?? Date.now();
  const cutoff = now - RETENTION_MS;

  let entries = buffer.get(agent_id);
  if (!entries) {
    entries = [];
    buffer.set(agent_id, entries);
  }

  // Prune anything older than the retention window. Arrays stay small (cap 256)
  // so this O(n) pass is cheap and keeps memory bounded for long-lived agents.
  while (entries.length > 0 && entries[0].ts < cutoff) {
    entries.shift();
  }

  entries.push({ tool: tool_name, ts: now });

  // Drop oldest if over per-agent cap.
  while (entries.length > PER_AGENT_CAP) {
    entries.shift();
  }
}

/**
 * Drop agent keys whose entries have all expired. Callers don't need this
 * during normal operation (prune-on-insert keeps active agents tidy) but
 * it prevents the outer Map from accumulating dead keys for agents that
 * disconnect and never return. Call from a periodic sweep if desired.
 */
export function sweepExpiredAgents(nowMs: number = Date.now()): void {
  const cutoff = nowMs - RETENTION_MS;
  for (const [agent_id, entries] of buffer) {
    while (entries.length > 0 && entries[0].ts < cutoff) {
      entries.shift();
    }
    if (entries.length === 0) buffer.delete(agent_id);
  }
}

/**
 * Did `agent_id` invoke any memory-query tool in the half-open window
 * [sinceMs, untilMs)? Returns false for unknown agents.
 */
export function hasMemoryQuery(agent_id: string, sinceMs: number, untilMs: number): boolean {
  const entries = buffer.get(agent_id);
  if (!entries || entries.length === 0) return false;
  for (const entry of entries) {
    if (entry.ts >= sinceMs && entry.ts < untilMs) return true;
  }
  return false;
}

/**
 * Test-only reset. Not exported via index.ts; tests import from the module
 * directly. Production code never calls this.
 */
export function _resetMemoryQueryBuffer(): void {
  buffer.clear();
}
