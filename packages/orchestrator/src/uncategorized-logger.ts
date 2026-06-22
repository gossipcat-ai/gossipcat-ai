/**
 * UncategorizedLogger — appends a JSONL record when extractCategories returns []
 * for a finding. Phase 1: visibility only. No scoring impact.
 *
 * Also exports getUncategorizedStatusLine for use in gossip_status banners.
 */

import { appendFileSync, mkdirSync, statSync, renameSync, createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';

/** Max bytes for `.gossip/uncategorized-findings.jsonl` before single-slot rotation. */
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Best-effort single-slot rotation. Mirrors sandbox.ts rotateIfNeeded.
 * If the file exists and exceeds maxBytes, rename to `<path>.1` (overwrites).
 * Errors are silently ignored — this is best-effort telemetry.
 */
function rotateIfNeeded(filePath: string, maxBytes: number): void {
  try {
    const st = statSync(filePath); // throws ENOENT when file absent — skip rotation
    if (st.size < maxBytes) return;
    try {
      renameSync(filePath, filePath + '.1');
    } catch (err) {
      process.stderr.write(`[uncategorized-logger] rotation failed: ${(err as Error).message}\n`);
    }
  } catch {
    /* file absent or unreadable — no rotation needed */
  }
}

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

  rotateIfNeeded(logPath, MAX_FILE_SIZE);
  try {
    appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write(`[uncategorized-logger] write failed: ${(err as Error).message}\n`);
  }
}

/**
 * Scans uncategorized-findings.jsonl files for recent entries and returns a
 * formatted status line for gossip_status.
 *
 * @param projectRoot The root of the project directory.
 * @param opts Optional parameters for window and current time.
 * @returns A formatted string or an empty string if no recent findings.
 */
export async function getUncategorizedStatusLine(
  projectRoot: string,
  opts?: { windowMs?: number; nowMs?: number }
): Promise<string> {
  const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
  const now = opts?.nowMs ?? Date.now();
  const cutoff = now - (opts?.windowMs ?? WINDOW_7D_MS);
  let count = 0;
  let mostRecentText = '';
  let mostRecentTs = 0;

  const uncatPath = join(projectRoot, '.gossip', 'uncategorized-findings.jsonl');

  const scanFile = (filePath: string): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!existsSync(filePath)) {
        return resolve();
      }
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      stream.on('error', () => resolve()); // absent or unreadable — skip
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line) return;
        try {
          const rec = JSON.parse(line) as { timestamp_iso?: string; text?: string };
          const ts = rec.timestamp_iso ? Date.parse(rec.timestamp_iso) : 0;
          if (ts >= cutoff) {
            count++;
            if (ts > mostRecentTs) {
              mostRecentTs = ts;
              mostRecentText = (rec.text ?? '').slice(0, 80);
            }
          }
        } catch {
          /* skip malformed line */
        }
      });
      rl.on('close', resolve);
      rl.on('error', () => resolve());
    });

  // Scan current file first, then rotation backup if present.
  await scanFile(uncatPath);
  if (existsSync(uncatPath + '.1')) {
    await scanFile(uncatPath + '.1');
  }

  if (count > 0) {
    return `\n  Uncategorized findings: ${count} in last 7d (sample: "${mostRecentText}...")`;
  }

  return '';
}
