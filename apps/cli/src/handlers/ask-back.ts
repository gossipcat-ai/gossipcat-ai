/**
 * gossip_ask_back — agent fabrication introspection loop.
 *
 * After a hallucination_caught signal is recorded, the orchestrator calls
 * gossip_ask_back(action:'ask') to re-engage the offending agent for a
 * first-person root-cause explanation. The answer is logged to
 * .gossip/fabrication-introspections.jsonl, turning a bare signal count into
 * rich first-person failure substrate for skill development.
 *
 * Unit 4 of the orchestrator signal pipeline feature.
 */

import { mkdirSync as realMkdirSync, appendFileSync as realAppendFileSync, readFileSync as realReadFileSync, statSync as realStatSync, renameSync as realRenameSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntrospectionRecord {
  agentId: string;
  findingId?: string;
  claim: string;
  groundTruth: string;
  answer?: string;
  status: 'asked' | 'answered';
  /** Present on 'asked' records; omitted on 'answered'-only records (FIX 4). */
  askedAt?: string;
  answeredAt?: string;
}

// Injected fs seam for tests
export interface FsDepsAppend {
  mkdirSync(path: string, opts?: unknown): void;
  appendFileSync(path: string, data: string): void;
  /** Optional: injected for rotation. Defaults to real statSync. */
  statSync?: (path: string) => { size: number };
  /** Optional: injected for rotation. Defaults to real renameSync. */
  renameSync?: (src: string, dest: string) => void;
}

export interface FsDepsRead {
  readFileSync(path: string): string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEDGER_REL = join('.gossip', 'fabrication-introspections.jsonl');

/** Single-slot rotation threshold — mirrors performance-writer.ts MAX_TELEMETRY_BYTES (5MB). */
export const MAX_INTROSPECTION_BYTES = 5 * 1024 * 1024; // 5MB

function ledgerPath(projectRoot: string): string {
  return join(projectRoot, LEDGER_REL);
}

// ---------------------------------------------------------------------------
// buildIntrospectionPrompt
// ---------------------------------------------------------------------------

/**
 * Build a tight, non-accusatory introspection prompt.
 *
 * Asks the agent to name the SPECIFIC process failure (e.g. "pattern-matched
 * the task framing", "cited from memory without opening the file") — a
 * mechanism, not an apology.
 */
export function buildIntrospectionPrompt(claim: string, groundTruth: string): string {
  return [
    'You are being asked to help improve the reliability of this review pipeline.',
    '',
    'A prior response from you was identified as a fabrication:',
    `  Claim made:    ${claim}`,
    `  Ground truth:  ${groundTruth}`,
    '',
    'Please reflect on the specific process failure that led to this.',
    'Do not apologize — instead, name the exact mechanism: for example,',
    '"I pattern-matched the task framing and assumed the identifier existed"',
    'or "I cited from memory without opening the file to verify".',
    '',
    'Your answer should be one to three sentences describing the HOW and WHY',
    'of the specific reasoning step that went wrong.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// appendIntrospection
// ---------------------------------------------------------------------------

/**
 * Append one IntrospectionRecord as a JSONL line to the ledger.
 *
 * Best-effort: never throws. Undefined optional fields are omitted from the
 * serialized output (not serialized as null).
 */
export function appendIntrospection(
  projectRoot: string,
  record: IntrospectionRecord,
  deps?: FsDepsAppend,
): void {
  // Required-field guard (FIX 3 + FIX 4):
  // - agentId and status are always required and must be non-empty strings.
  // - claim and groundTruth must be non-empty (trimmed) ONLY when status==='asked'.
  //   An 'answered' record legitimately omits them (caller passes '' from mcp-server-sdk).
  // - askedAt is required only for 'asked' records; 'answered' records may omit it.
  if (
    typeof record.agentId !== 'string' || !record.agentId ||
    typeof record.status !== 'string' || !record.status
  ) {
    return;
  }
  if (record.status === 'asked') {
    if (
      typeof record.claim !== 'string' || !record.claim.trim() ||
      typeof record.groundTruth !== 'string' || !record.groundTruth.trim()
    ) {
      return;
    }
  }

  // Build clean object without undefined keys
  const clean: Record<string, unknown> = {
    agentId: record.agentId,
    claim: record.claim,
    groundTruth: record.groundTruth,
    status: record.status,
  };
  if (record.askedAt !== undefined) clean['askedAt'] = record.askedAt;
  if (record.findingId !== undefined) clean['findingId'] = record.findingId;
  if (record.answer !== undefined) clean['answer'] = record.answer;
  if (record.answeredAt !== undefined) clean['answeredAt'] = record.answeredAt;

  const line = JSON.stringify(clean) + '\n';
  const path = ledgerPath(projectRoot);

  try {
    const fsMkdir = deps?.mkdirSync ?? realMkdirSync;
    const fsAppend = deps?.appendFileSync ?? realAppendFileSync;
    const fsStat = deps?.statSync ?? realStatSync;
    const fsRename = deps?.renameSync ?? realRenameSync;
    fsMkdir(join(projectRoot, '.gossip'), { recursive: true });
    // FIX 5: single-slot rotation — mirrors performance-writer.ts rotateJsonlIfNeeded.
    // Best-effort: if stat/rename fails (file missing, unwritable), just continue to append.
    try {
      const st = fsStat(path);
      if (st.size >= MAX_INTROSPECTION_BYTES) {
        fsRename(path, path + '.1');
      }
    } catch { /* file missing or stat/rename failed — next append re-creates */ }
    fsAppend(path, line);
  } catch {
    // Best-effort: swallow all errors
  }
}

// ---------------------------------------------------------------------------
// readIntrospections
// ---------------------------------------------------------------------------

/**
 * Read and parse the introspection ledger.
 *
 * Lenient: skips torn/invalid JSON lines. Returns [] if the file is missing.
 * Optional agentId filter: when provided, only records for that agent are returned.
 */
export function readIntrospections(
  projectRoot: string,
  agentId?: string,
  deps?: FsDepsRead,
): IntrospectionRecord[] {
  const path = ledgerPath(projectRoot);
  const fsRead = deps?.readFileSync ?? realReadFileSync;

  // FIX 5: read rotated .1 file first (older), then the live file.
  // Lenient: missing/unreadable files are treated as empty.
  const rawParts: string[] = [];
  try { rawParts.push(fsRead(path + '.1') as string); } catch { /* missing */ }
  try { rawParts.push(fsRead(path) as string); } catch { /* missing */ }

  if (rawParts.length === 0) return [];
  const raw = rawParts.join('');

  const records: IntrospectionRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as IntrospectionRecord;
      if (agentId !== undefined && parsed.agentId !== agentId) continue;
      records.push(parsed);
    } catch {
      // Skip torn lines
    }
  }
  return records;
}
