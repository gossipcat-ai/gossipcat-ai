/**
 * UncategorizedLogger — appends a JSONL record when extractCategories returns []
 * for a finding. Phase 1: visibility only. No scoring impact.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface UncategorizedFindingContext {
  finding_id?: string;
  agent_id?: string;
  taskId?: string;
}

export interface UncategorizedFindingRecord {
  timestamp_iso: string;
  finding_id?: string;
  agent_id?: string;
  taskId?: string;
  text: string;
}

const MAX_TEXT_LEN = 600;

export function logUncategorizedFinding(
  text: string,
  ctx: UncategorizedFindingContext,
  projectRoot: string,
): void {
  const gossipDir = join(projectRoot, '.gossip');
  mkdirSync(gossipDir, { recursive: true });
  const logPath = join(gossipDir, 'uncategorized-findings.jsonl');

  const record: UncategorizedFindingRecord = {
    timestamp_iso: new Date().toISOString(),
    text: text.slice(0, MAX_TEXT_LEN),
  };
  if (ctx.finding_id !== undefined) record.finding_id = ctx.finding_id;
  if (ctx.agent_id !== undefined) record.agent_id = ctx.agent_id;
  if (ctx.taskId !== undefined) record.taskId = ctx.taskId;

  appendFileSync(logPath, JSON.stringify(record) + '\n');
}
