// packages/orchestrator/src/audit-log-chain.ts
//
// Hash-chained append-only audit log for the open-findings auto-resolver.
// Spec: docs/specs/2026-04-27-open-findings-auto-resolve.md (rev2,
// consensus b3f57cc6-22c24114) — "Audit log" + "Append safety" sections.
//
// Each appended entry carries:
//   prev_hash  — sha256 of the previous entry's serialized form (without
//                its own entry_hash field), or 64-char zero string for
//                the first entry.
//   entry_hash — sha256 of THIS entry's content excluding entry_hash.
//
// `verifyChain` walks the file and reports the index of the first broken
// entry (or null if intact). The chain is not adversarial — anyone with
// disk access can replay it — but it detects accidental corruption,
// partial writes, and casual tampering.
//
// Append safety: writes are line-sized (entries fit well under PIPE_BUF
// 512 bytes for typical resolutions). On POSIX, `writeFileSync(.., {flag: "a"})`
// of a single line is atomic up to PIPE_BUF, so concurrent appenders never
// observe a torn line. The resolver lock (file-lock.ts) serializes
// appends inside the resolver itself; this module additionally tolerates
// non-resolver appenders (e.g., manual `gossip_signals(action: "resolve")`
// outside the auto-trigger path).

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export const ZERO_HASH = '0'.repeat(64);
export const AUDIT_LOG_FILENAME = 'finding-resolutions.jsonl';

/**
 * The shape we persist. `prev_hash` and `entry_hash` are added at append
 * time — callers pass everything else.
 */
export interface AuditEntryInput {
  ts: string; // ISO-8601
  finding_id: string;
  action: 'resolve' | 'unresolve' | 'path_validation_rejected';
  resolved_by?: 'commit:' | 'stale_anchor' | 'manual' | string;
  before_quote?: string;
  after_check?: 'absent' | 'moved' | 'renamed' | 'rejected_path' | string;
  operator?: 'auto' | string;
  reason?: string;
  // Free-form payload for path_validation_rejected diagnostics, etc.
  // Anything additional is hashed verbatim.
  [k: string]: unknown;
}

export interface AuditEntry extends AuditEntryInput {
  prev_hash: string;
  entry_hash: string;
}

/**
 * Compute the SHA-256 hash of a serialized entry, excluding its
 * `entry_hash` field (the hash cannot include itself).
 *
 * Stable serialization: keys sorted alphabetically, then JSON.stringify.
 * This is what we hash AND what we write — so verifyChain can recompute
 * deterministically off the on-disk JSON.
 */
export function computeEntryHash(entry: Omit<AuditEntry, 'entry_hash'>): string {
  const stable = stableStringify(entry);
  return createHash('sha256').update(stable).digest('hex');
}

/**
 * Stable JSON: keys sorted at every object level. Arrays preserve order
 * (their elements are serialized as-is). Used both for hashing and for
 * writing to disk so verifyChain can rehash a parsed line and compare.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue; // omit undefineds
    parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

function auditLogPath(projectRoot: string): string {
  return path.join(projectRoot, '.gossip', AUDIT_LOG_FILENAME);
}

/**
 * Read the last entry's `entry_hash` to chain the next append. Returns
 * ZERO_HASH for an empty/missing file. On corrupt tail, falls back to
 * ZERO_HASH so the next entry still writes — verifyChain will surface
 * the corruption as a tamper detection.
 */
function readLastEntryHash(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return ZERO_HASH;
  }
  const linesArr = raw.split('\n').filter((l) => l.length > 0);
  if (linesArr.length === 0) return ZERO_HASH;
  const last = linesArr[linesArr.length - 1];
  try {
    const parsed = JSON.parse(last) as { entry_hash?: unknown };
    if (typeof parsed.entry_hash === 'string' && /^[0-9a-f]{64}$/.test(parsed.entry_hash)) {
      return parsed.entry_hash;
    }
  } catch { /* fall through */ }
  return ZERO_HASH;
}

/**
 * Append a hash-chained entry to `.gossip/finding-resolutions.jsonl`.
 * Returns the entry as written (with `prev_hash` + `entry_hash` filled).
 *
 * Caller is responsible for any concurrency control (the resolver wraps
 * this in `withResolverLock`).
 */
export function appendChainedEntry(
  projectRoot: string,
  input: AuditEntryInput,
): AuditEntry {
  const file = auditLogPath(projectRoot);
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }

  const prev_hash = readLastEntryHash(file);
  const withPrev = { ...input, prev_hash } as Omit<AuditEntry, 'entry_hash'>;
  const entry_hash = computeEntryHash(withPrev);
  const entry = { ...withPrev, entry_hash } as AuditEntry;
  const line = stableStringify(entry) + '\n';

  // Append-only, atomic-for-line-sized-writes (POSIX PIPE_BUF >= 512).
  fs.writeFileSync(file, line, { flag: 'a' });
  return entry;
}

/**
 * Verify the on-disk chain. Returns `null` when intact; otherwise returns
 * the index (0-based) of the first broken entry plus the reason.
 */
export function verifyChain(
  projectRoot: string,
): { brokenAtIndex: number; reason: string } | null {
  const file = auditLogPath(projectRoot);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return null; /* missing file → empty chain → intact */ }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  let expectedPrev = ZERO_HASH;
  for (let i = 0; i < lines.length; i++) {
    let parsed: AuditEntry;
    try { parsed = JSON.parse(lines[i]) as AuditEntry; }
    catch { return { brokenAtIndex: i, reason: 'unparseable JSON' }; }
    if (parsed.prev_hash !== expectedPrev) {
      return { brokenAtIndex: i, reason: `prev_hash mismatch (got ${parsed.prev_hash.slice(0, 12)}…, expected ${expectedPrev.slice(0, 12)}…)` };
    }
    const { entry_hash, ...withoutHash } = parsed;
    const recomputed = computeEntryHash(withoutHash);
    if (recomputed !== entry_hash) {
      return { brokenAtIndex: i, reason: `entry_hash mismatch (got ${entry_hash.slice(0, 12)}…, expected ${recomputed.slice(0, 12)}…)` };
    }
    expectedPrev = entry_hash;
  }
  return null;
}
