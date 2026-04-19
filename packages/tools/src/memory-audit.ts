/**
 * Memory-query audit logger — `.gossip/memory-queries.jsonl`.
 *
 * Spec: docs/specs/2026-04-19-gossip-remember-hardening.md (Part 6).
 * Consensus: 51b3f57c-45e541dd:f18.
 *
 * Schema (one JSON object per line):
 * {
 *   timestamp: string,        // ISO-8601
 *   agentId: string,          // queried agent_id
 *   query_hash: string,       // sha1 of query string (PII-safe)
 *   query_length: number,     // for analytics
 *   max_results: number,
 *   results_count: number,    // after search
 *   attributed: boolean,      // true when caller identity is authenticated
 *   _audit?: 'untrusted_caller' // legacy unauthenticated path marker
 * }
 *
 * Rotation: single-slot 5MB, mirroring boundary-escapes.jsonl. All IO wrapped
 * in try/catch — best-effort, never throws into the tool response.
 */

import { appendFileSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export const MEMORY_QUERY_LOG = 'memory-queries.jsonl';
export const MAX_MEMORY_QUERY_LOG_BYTES = 5 * 1024 * 1024; // 5MB

export interface MemoryAuditEntry {
  agentId: string;
  query: string;
  max_results: number;
  results_count: number;
  attributed: boolean;
  auditTag?: 'untrusted_caller';
}

/**
 * Best-effort single-slot size rotation (mirrors sandbox.rotateIfNeeded). If
 * the log is at or over `maxBytes`, rename to `path + '.1'`, overwriting any
 * pre-existing `.1` slot. Silent on any error.
 */
function rotateJsonlIfNeeded(filePath: string, maxBytes: number): void {
  try {
    const st = statSync(filePath);
    if (st.size < maxBytes) return;
    renameSync(filePath, filePath + '.1');
  } catch {
    // No-op: missing file, EPERM, race — all fine.
  }
}

/**
 * Append one audit row. Silent on any error.
 */
export function recordMemoryQuery(projectRoot: string, entry: MemoryAuditEntry): void {
  try {
    const gossipDir = join(projectRoot, '.gossip');
    const logPath = join(gossipDir, MEMORY_QUERY_LOG);
    rotateJsonlIfNeeded(logPath, MAX_MEMORY_QUERY_LOG_BYTES);
    const row: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      agentId: entry.agentId,
      query_hash: createHash('sha1').update(entry.query).digest('hex'),
      query_length: entry.query.length,
      max_results: entry.max_results,
      results_count: entry.results_count,
      attributed: entry.attributed,
    };
    if (entry.auditTag) row._audit = entry.auditTag;
    appendFileSync(logPath, JSON.stringify(row) + '\n');
  } catch {
    // Best-effort — never throw into the tool response path.
  }
}
