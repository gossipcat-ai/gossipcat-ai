// packages/orchestrator/src/round-counter.ts
//
// Per-round signal counter for Phase A system self-telemetry.
// Catches silent signal-loss bugs (like the historical 6-drop-gate bug) at
// the moment of loss rather than after the fact.
//
// Persistence model — Option C (spec 2026-04-27-self-telemetry-crash-consistency):
// counter mutations are merged into the same append-only JSONL stream as
// signals (`<projectRoot>/.gossip/agent-performance.jsonl`). Each "bump" is a
// `{type:"_meta",signal:"round_counter_bumped",consensusId,bumpedAt}` record;
// each "reset" is a `{type:"_meta",signal:"round_counter_reset",consensusId,resetAt}`
// record. Readers rebuild counter state by scanning the JSONL after the most
// recent reset for each consensusId. Crash-consistency property: a process
// crash mid-append can only truncate the LAST record (POSIX guarantee on
// records ≤ PIPE_BUF / single write(2)), so the signal-write and counter-bump
// can never split across two files because they ARE one file now.
//
// Concurrency:
//   - All mutations use append-only writes via a single `appendFileSync` call.
//     Records are <100B (well under POSIX-min PIPE_BUF=512B), so the kernel
//     guarantees no interleaving with concurrent writers.
//   - No read-modify-write lock between processes; readers always scan the
//     entire stream after the most recent reset, so concurrent bumps
//     accumulate cleanly (each bump is its own append, no last-writer-wins).
//   - Read-only filesystem: append failure is caught and a fallback in-memory
//     map tracks bumps so this process at least sees its own work.
//   - `reset()` on a read-only filesystem masks the persisted count via the
//     same fallback map (set to 0).
//
// Backwards compatibility:
//   - The legacy `<projectRoot>/.gossip/round-counters.json` file is no longer
//     read or written. The file may still exist on disk from prior versions;
//     it is silently ignored.

import * as fs from 'fs';
import * as path from 'path';

const JSONL_FILENAME = 'agent-performance.jsonl';

/**
 * In-memory fallback used when the filesystem rejects writes (read-only fs,
 * EPERM, ENOSPC, etc). Keyed by `<projectRoot>:<consensusId>` to keep multiple
 * project roots independent in the same process.
 */
const inMemoryFallback = new Map<string, number>();
const fallbackKey = (projectRoot: string, consensusId: string): string =>
  `${projectRoot} ${consensusId}`;

/**
 * Per-(filePath,mtimeMs) cache for the JSONL scan result. Avoids re-scanning
 * the entire stream on every `get()` call when the file has not been modified.
 * Keyed by absolute file path. Each entry stores the mtime that was current at
 * scan time and the per-consensusId derived counts.
 */
interface ScanCache {
  mtimeMs: number;
  size: number;
  counts: Map<string, number>;
}
const scanCache = new Map<string, ScanCache>();

function jsonlPath(projectRoot: string): string {
  return path.join(projectRoot, '.gossip', JSONL_FILENAME);
}

/**
 * Append a single `_meta` record (bump or reset) to the JSONL. Returns true on
 * success, false if the filesystem rejected the write. Caller falls back to the
 * in-memory map on `false`.
 *
 * Records are tiny (<100B) so the kernel guarantees no interleaving with
 * concurrent writers — no extra fsync needed.
 */
function appendMetaRecord(
  projectRoot: string,
  record: Record<string, unknown>,
): boolean {
  const target = jsonlPath(projectRoot);
  const dir = path.dirname(target);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* best-effort */ }
  try {
    fs.appendFileSync(target, JSON.stringify(record) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan the JSONL stream and rebuild counter state per consensusId. For each
 * consensusId, only `_meta`/`round_counter_bumped` records that occur AFTER
 * the most recent `_meta`/`round_counter_reset` record for that consensusId
 * are counted. Malformed lines (truncated tail, partial JSON) are skipped.
 */
function scanJsonl(filePath: string): Map<string, number> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return new Map();
  }
  if (raw.length === 0) return new Map();

  // Two-pass scan: first find the most recent reset offset per consensusId,
  // then count bumps strictly after that line index. Cheaper than tracking a
  // running map because resets are rare relative to bumps.
  const lines = raw.split('\n');
  const lastReset = new Map<string, number>(); // consensusId → line index of last reset
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec && rec.type === '_meta' && rec.signal === 'round_counter_reset' && typeof rec.consensusId === 'string') {
      lastReset.set(rec.consensusId, i);
    }
  }
  const counts = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec && rec.type === '_meta' && rec.signal === 'round_counter_bumped' && typeof rec.consensusId === 'string') {
      const resetAt = lastReset.get(rec.consensusId);
      if (resetAt !== undefined && i <= resetAt) continue;
      counts.set(rec.consensusId, (counts.get(rec.consensusId) ?? 0) + 1);
    }
  }
  return counts;
}

function readCountsCached(projectRoot: string): Map<string, number> {
  const filePath = jsonlPath(projectRoot);
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    // Missing file — treat as empty. Drop cached entry if any.
    scanCache.delete(filePath);
    return new Map();
  }
  const cached = scanCache.get(filePath);
  // Rotation invariant: rotateJsonlIfNeeded (performance-writer.ts) renames the
  // JSONL away once it crosses the size threshold (~5MB) and creates a fresh
  // empty file. Cache key is filePath only, but invalidation is safe because
  // the new file's size (0B) and mtime differ from any cached entry from the
  // pre-rotation file (~5MB), forcing a fresh scan that correctly returns 0
  // bumps for the new stream.
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.counts;
  }
  const counts = scanJsonl(filePath);
  scanCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, counts });
  return counts;
}

/**
 * Increment the signal count for `consensusId` by 1.
 *
 * Under Option C this appends a `_meta`/`round_counter_bumped` record to the
 * JSONL stream. The hot path inside `PerformanceWriter` no longer calls this
 * function — it inlines the same record into the same `appendFileSync` call as
 * the signal payload, which is the actual crash-consistency win. This export
 * is retained for direct test callers and any external code that still drives
 * the counter manually.
 */
export function bump(projectRoot: string, consensusId: string): void {
  const record = {
    type: '_meta',
    signal: 'round_counter_bumped',
    consensusId,
    bumpedAt: new Date().toISOString(),
    _emission_path: 'round-counter-bump',
  };
  const ok = appendMetaRecord(projectRoot, record);
  const fbk = fallbackKey(projectRoot, consensusId);
  if (!ok) {
    // Filesystem unavailable — keep an in-memory shadow so this process at
    // least sees its own bumps within this lifetime.
    const next = (inMemoryFallback.get(fbk) ?? 0) + 1;
    inMemoryFallback.set(fbk, next);
  } else {
    // FS recovered — flush any in-memory bumps accumulated during the read-only
    // period before clearing the fallback. If any backfill append fails, keep
    // the fallback intact (atomic flush: all-or-nothing).
    const priorCount = inMemoryFallback.get(fbk) ?? 0;
    if (priorCount > 0) {
      let allFlushed = true;
      for (let i = 0; i < priorCount; i++) {
        const backfillRecord = {
          type: '_meta',
          signal: 'round_counter_bumped',
          consensusId,
          bumpedAt: new Date().toISOString(),
          _emission_path: 'round-counter-bump-backfill',
        };
        if (!appendMetaRecord(projectRoot, backfillRecord)) {
          allFlushed = false;
          break;
        }
      }
      if (allFlushed) {
        inMemoryFallback.delete(fbk);
      }
      // If !allFlushed, fbk stays at priorCount — next successful bump will retry.
    } else {
      inMemoryFallback.delete(fbk);
    }
  }
}

/** Return the current signal count for `consensusId` (0 if never bumped). */
export function get(projectRoot: string, consensusId: string): number {
  // In-memory fallback takes precedence when present. This is the override
  // layer for two degraded-mode scenarios:
  //   1. bump() on a read-only fs: in-memory tracks bumps the file couldn't persist.
  //   2. reset() on a read-only fs: in-memory is set to 0 so the JSONL-derived
  //      count is masked — get() returns 0 even though the JSONL still has the
  //      pre-reset bumps with no reset record persisted.
  const fbk = fallbackKey(projectRoot, consensusId);
  if (inMemoryFallback.has(fbk)) return inMemoryFallback.get(fbk) ?? 0;
  const counts = readCountsCached(projectRoot);
  return counts.get(consensusId) ?? 0;
}

/** Reset the counter for `consensusId`. Used in tests and explicit cleanup. */
export function reset(projectRoot: string, consensusId: string): void {
  const record = {
    type: '_meta',
    signal: 'round_counter_reset',
    consensusId,
    resetAt: new Date().toISOString(),
    _emission_path: 'round-counter-reset',
  };
  const ok = appendMetaRecord(projectRoot, record);
  const fbk = fallbackKey(projectRoot, consensusId);
  if (ok) {
    // Persisted reset supersedes any prior in-memory fallback entry.
    inMemoryFallback.delete(fbk);
  } else {
    // Persisted append failed (read-only fs). Mask the prior count via the
    // in-memory layer so subsequent get() calls return 0 — the JSONL still
    // carries the pre-reset bumps but the fallback map takes precedence.
    inMemoryFallback.set(fbk, 0);
  }
}

/**
 * Derive a consensusId from a signal record. Returns the consensusId if
 * present, else extracts the prefix from a findingId that matches
 * `<8hex>-<8hex>:...`. Returns undefined when neither is available (meta,
 * impl, ad-hoc signals that don't belong to a consensus round).
 */
export function deriveConsensusId(record: {
  consensusId?: string;
  findingId?: string;
}): string | undefined {
  if (record.consensusId) return record.consensusId;
  if (typeof record.findingId === 'string') {
    const prefix = record.findingId.split(':')[0];
    if (/^[0-9a-f]{8}-[0-9a-f]{8}$/.test(prefix)) return prefix;
  }
  return undefined;
}

/**
 * Build a counter-bump meta-record for inline emission by the signal-write
 * hot path (PerformanceWriter). Exported so the writer can construct the
 * record inside its own `appendFileSync` call — the whole point of Option C
 * is that the signal payload and the bump record share a single syscall.
 */
export function makeBumpRecord(
  consensusId: string,
  emissionPath: string,
): Record<string, unknown> {
  return {
    type: '_meta',
    signal: 'round_counter_bumped',
    consensusId,
    bumpedAt: new Date().toISOString(),
    _emission_path: emissionPath,
  };
}

/**
 * Test-only: clear in-memory fallback state and the JSONL scan cache.
 * Persisted JSONL state is untouched — tests own the temp directory and clean
 * it themselves.
 * @internal
 */
export function __resetForTests(): void {
  inMemoryFallback.clear();
  scanCache.clear();
}
