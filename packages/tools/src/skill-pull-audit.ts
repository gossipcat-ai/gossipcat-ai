/**
 * Skill-pull observability log — `.gossip/skill-pulls.jsonl`.
 *
 * Issue #715 / #698 part 2. Every SUCCESSFUL on-demand skill fetch (relay
 * `skill_query`, native `gossip_skill_query`) appends one row here. Failed
 * resolutions are deliberately NOT logged — a pull row means "an agent wanted
 * this skill and the loader had it but had not injected it", which is exactly
 * the keyword-gate-miss evidence stream future contextual-selection tuning
 * needs. Mixing in not-found rows would dilute that signal with typos.
 *
 * Schema (one JSON object per line):
 * {
 *   timestamp: string,               // ISO-8601
 *   agent_id: string,                // pulling agent
 *   skill: string,                   // skill name as requested
 *   resolved_path: string,           // absolute path the resolver returned
 *   runtime: 'relay' | 'native',
 *   task_id?: string                 // only when the call site has one cheaply
 * }
 *
 * Rotation: single-slot 5MB, mirroring memory-queries.jsonl. All IO wrapped in
 * try/catch — fail-open, never throws into the tool response.
 */

import { appendFileSync, statSync, renameSync } from 'fs';
import { join } from 'path';

export const SKILL_PULL_LOG = 'skill-pulls.jsonl';
export const MAX_SKILL_PULL_LOG_BYTES = 5 * 1024 * 1024; // 5MB

export interface SkillPullEntry {
  agentId: string;
  skill: string;
  resolvedPath: string;
  runtime: 'relay' | 'native';
  taskId?: string;
}

/**
 * Best-effort single-slot size rotation (mirrors memory-audit.rotateJsonlIfNeeded).
 * Silent on any error.
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

/** Append one pull row. Silent on any error (fail-open). */
export function recordSkillPull(projectRoot: string, entry: SkillPullEntry): void {
  try {
    const logPath = join(projectRoot, '.gossip', SKILL_PULL_LOG);
    rotateJsonlIfNeeded(logPath, MAX_SKILL_PULL_LOG_BYTES);
    const row: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      agent_id: entry.agentId,
      skill: entry.skill,
      resolved_path: entry.resolvedPath,
      runtime: entry.runtime,
    };
    if (entry.taskId) row.task_id = entry.taskId;
    appendFileSync(logPath, JSON.stringify(row) + '\n');
  } catch {
    // Best-effort — a logging failure must never break the tool call.
  }
}
