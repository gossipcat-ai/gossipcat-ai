/**
 * UncategorizedLogger — appends a JSONL record when extractCategories returns []
 * for a finding. Phase 1: visibility only. No scoring impact.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/** Redact common secret patterns to prevent leaking credentials into the log. */
function redactSecrets(text: string): string {
  return text
    .replace(/sk[-_]live[-_][a-zA-Z0-9]{20,}/g, '[REDACTED_STRIPE_KEY]')
    .replace(/sk[-_]ant[-_][a-zA-Z0-9]{20,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/sk[-_][a-zA-Z0-9]{40,}/g, '[REDACTED_API_KEY]')
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/gho_[a-zA-Z0-9]{36,}/g, '[REDACTED_GITHUB_OAUTH]')
    .replace(/AIza[a-zA-Z0-9_-]{35}/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/eyJ[a-zA-Z0-9_-]{50,}\.[a-zA-Z0-9_-]{50,}\.[a-zA-Z0-9_-]{50,}/g, '[REDACTED_JWT]')
    .replace(/-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

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
    text: redactSecrets(text).slice(0, MAX_TEXT_LEN),
  };
  if (ctx.finding_id !== undefined) record.finding_id = ctx.finding_id;
  if (ctx.agent_id !== undefined) record.agent_id = ctx.agent_id;
  if (ctx.taskId !== undefined) record.taskId = ctx.taskId;

  try {
    appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write(`[uncategorized-logger] write failed: ${(err as Error).message}\n`);
  }
}
