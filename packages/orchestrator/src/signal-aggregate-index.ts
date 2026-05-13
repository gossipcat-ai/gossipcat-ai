// @gossip:impact-adjacent:signal_pipeline
/**
 * Signal aggregate sidecar — Phase B complement to readJsonlWithRotated.
 *
 * Phase A (PR #367) made readers walk `.gossip/agent-performance.jsonl.1` so
 * historical evidence survives single-slot rotation. Phase B writes a small
 * derived aggregate at `.gossip/signal-aggregate-index.json` so the destructive
 * rotation of the raw rows does not erase counts that have already been
 * scored.
 *
 * Schema (version 1):
 *
 *   {
 *     "version": 1,
 *     "rebuiltAt": <iso>,
 *     "lastRawTimestampMs": <number>,
 *     "agents": {
 *       "<agentId>": {
 *         "<category>": {
 *           "<boundAtMs>": {
 *             "correct": N,
 *             "hallucinated": N,
 *             "total": N,
 *             "lastUpdateMs": <number>,
 *             "recentRetractedConsensusIds": [<lastFew>]
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Mirrors `skill-index.ts`: synchronous `writeFileSync`, no mutex. The raw
 * jsonl remains the system of record — any sidecar I/O error is LOGGED and
 * swallowed so a read-only filesystem cannot wedge the signal write path.
 *
 * On read, callers use `lastRawTimestampMs` against the live jsonl mtime to
 * detect a stale sidecar (process crashed between jsonl append and sidecar
 * write) and trigger a rebuild from `readJsonlWithRotated`.
 *
 * Spec: docs/specs/2026-05-13-signal-log-aggregate-sidecar.md (gitignored).
 * Followup to PR #367 (commit 6644cba).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { ConsensusSignal } from './consensus-types';
import { readJsonlWithRotated } from './performance-reader';
import { SAFE_NAME } from './skill-engine';

export const SIDECAR_VERSION = 1;
export const SIDECAR_FILENAME = 'signal-aggregate-index.json';
export const AGENT_PERFORMANCE_FILENAME = 'agent-performance.jsonl';
const RECENT_RETRACTIONS_CAP = 16;

// Fix 1: mtime-keyed reader cache — mirrors PerformanceReader.cachedScores pattern.
let cachedAggregateData: SignalAggregateIndexData | null = null;
let cachedAggregateMtimeMs = 0;

export interface SignalAggregateBucket {
  correct: number;
  hallucinated: number;
  total: number;
  lastUpdateMs: number;
  recentRetractedConsensusIds: string[];
}

export interface SignalAggregateIndexData {
  version: number;
  rebuiltAt: string;
  lastRawTimestampMs: number;
  agents: Record<string, Record<string, Record<string, SignalAggregateBucket>>>;
}

function emptyData(): SignalAggregateIndexData {
  return {
    version: SIDECAR_VERSION,
    rebuiltAt: new Date(0).toISOString(),
    lastRawTimestampMs: 0,
    agents: {},
  };
}

function logSidecarError(stage: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    process.stderr.write(`[gossipcat] signal-aggregate-sidecar ${stage} failed: ${msg}\n`);
  } catch { /* best-effort */ }
}

/**
 * Classify a consensus signal into one of: `correct`, `hallucinated`, or
 * `none` (does not move accuracy counters). Mirrors the switch in
 * performance-reader.getCountersSince.
 */
export function classifyForAggregate(signal: string): 'correct' | 'hallucinated' | 'none' {
  switch (signal) {
    case 'agreement':
    case 'category_confirmed':
    case 'consensus_verified':
    case 'unique_confirmed':
      return 'correct';
    case 'disagreement':
    case 'hallucination_caught':
      return 'hallucinated';
    default:
      return 'none';
  }
}

/**
 * Read the sidecar JSON from disk. Returns `null` if missing, malformed, or
 * carrying a version we don't recognise — callers must rebuild on `null`.
 *
 * Fix 1: mtime-keyed reader cache — skips readFileSync+JSON.parse when the
 *   file has not changed since the last read (mirrors PerformanceReader.getScores).
 * Fix 2: SAFE_NAME tamper validation — rejects hostile agentId/category keys
 *   that could cause identity mis-attribution (e.g. "../../etc/passwd").
 */
export function readAggregateIndex(projectRoot: string): SignalAggregateIndexData | null {
  const path = join(projectRoot, '.gossip', SIDECAR_FILENAME);
  if (!existsSync(path)) {
    cachedAggregateData = null;
    cachedAggregateMtimeMs = 0;
    return null;
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (err) {
    logSidecarError('stat', err);
    return null;
  }
  // Fix 1+2: cache hit — return without re-reading disk. The +1ms guard mirrors
  // sidecarIsStale's buffer and closes the same-ms external-write race where a
  // write lands at the same millisecond tick as the stat call.
  if (cachedAggregateData !== null && mtimeMs === cachedAggregateMtimeMs && Date.now() > cachedAggregateMtimeMs + 1) {
    return cachedAggregateData;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    logSidecarError('read', err);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logSidecarError('parse', err);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Partial<SignalAggregateIndexData>;
  if (obj.version !== SIDECAR_VERSION) return null;
  if (!obj.agents || typeof obj.agents !== 'object' || Array.isArray(obj.agents)) return null;
  // Fix 2: SAFE_NAME validation — reject any hostile key before caching.
  // Fix 3: also validate third-level boundAtMs keys (must be all-digit timestamps).
  for (const agentId of Object.keys(obj.agents)) {
    if (!SAFE_NAME.test(agentId)) return null;
    for (const category of Object.keys((obj.agents as Record<string, Record<string, unknown>>)[agentId] ?? {})) {
      if (!SAFE_NAME.test(category)) return null;
      for (const bucketKey of Object.keys((obj.agents as Record<string, Record<string, Record<string, unknown>>>)[agentId][category] ?? {})) {
        if (!/^\d+$/.test(bucketKey)) return null;
      }
    }
  }
  const result: SignalAggregateIndexData = {
    version: SIDECAR_VERSION,
    rebuiltAt: typeof obj.rebuiltAt === 'string' ? obj.rebuiltAt : new Date(0).toISOString(),
    lastRawTimestampMs: typeof obj.lastRawTimestampMs === 'number' ? obj.lastRawTimestampMs : 0,
    agents: obj.agents as SignalAggregateIndexData['agents'],
  };
  // Store in cache only after validation passes.
  cachedAggregateData = result;
  cachedAggregateMtimeMs = mtimeMs;
  return result;
}

/**
 * Atomic-write the sidecar JSON. Writes to `<path>.tmp` then renames.
 * Any error is logged and swallowed — sidecar durability is NEVER allowed to
 * fail the primary jsonl write path.
 */
export function writeAggregateIndex(projectRoot: string, data: SignalAggregateIndexData): void {
  const path = join(projectRoot, '.gossip', SIDECAR_FILENAME);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, path);
    // Fix 1: proactively update the reader cache after a successful write so
    // in-process reads return the fresh data without a disk round-trip.
    cachedAggregateData = data;
    cachedAggregateMtimeMs = statSync(path).mtimeMs;
  } catch (err) {
    logSidecarError('write', err);
  }
}

/**
 * Fold a single signal into a (mutable) sidecar. Returns true if the bucket
 * mutated. Caller resolves the active `boundAtMs` for the signal's
 * (agent, category) pair and passes it in — we make no filesystem calls here.
 *
 * `signal.timestamp` becomes the bucket's `lastUpdateMs`. Caller is responsible
 * for filtering out `_system` agent and operational signals before invoking.
 */
export function foldSignal(
  data: SignalAggregateIndexData,
  agentId: string,
  category: string,
  boundAtMs: number,
  signalName: string,
  timestampMs: number,
): boolean {
  const kind = classifyForAggregate(signalName);
  if (kind === 'none') return false;
  const bucket = ensureBucket(data, agentId, category, boundAtMs);
  if (kind === 'correct') bucket.correct++;
  else bucket.hallucinated++;
  bucket.total++;
  if (timestampMs > bucket.lastUpdateMs) bucket.lastUpdateMs = timestampMs;
  if (timestampMs > data.lastRawTimestampMs) data.lastRawTimestampMs = timestampMs;
  return true;
}

/**
 * Record a retracted consensus_id against every bucket that has signals from
 * that round. Phase B keeps a rolling list so readers can apply retraction
 * deltas without re-folding the whole jsonl.
 *
 * Returns the number of buckets touched.
 */
export function recordRetraction(
  data: SignalAggregateIndexData,
  consensusId: string,
): number {
  if (!consensusId) return 0;
  let touched = 0;
  for (const agent of Object.values(data.agents)) {
    for (const cat of Object.values(agent)) {
      for (const bucket of Object.values(cat)) {
        if (bucket.recentRetractedConsensusIds.includes(consensusId)) continue;
        bucket.recentRetractedConsensusIds.push(consensusId);
        if (bucket.recentRetractedConsensusIds.length > RECENT_RETRACTIONS_CAP) {
          bucket.recentRetractedConsensusIds.shift();
        }
        touched++;
      }
    }
  }
  return touched;
}

export const BUCKET_CAP = 5;

function ensureBucket(
  data: SignalAggregateIndexData,
  agentId: string,
  category: string,
  boundAtMs: number,
): SignalAggregateBucket {
  if (!data.agents[agentId]) data.agents[agentId] = Object.create(null);
  const byCat = data.agents[agentId];
  if (!byCat[category]) byCat[category] = Object.create(null);
  const byBound = byCat[category];
  const key = String(boundAtMs);
  if (!byBound[key]) {
    // Fix 3+4: evict oldest bucket(s) until below cap before inserting — while-loop
    // self-heals a pre-existing overcount (e.g. from a crash mid-eviction). Numeric
    // sort is critical — lexical sort mangles "9" > "10".
    const sorted = Object.keys(byBound).map(k => parseInt(k, 10)).sort((a, b) => a - b);
    while (sorted.length >= BUCKET_CAP) {
      delete byBound[String(sorted[0])];
      sorted.shift();
    }
    byBound[key] = {
      correct: 0,
      hallucinated: 0,
      total: 0,
      lastUpdateMs: 0,
      recentRetractedConsensusIds: [],
    };
  }
  return byBound[key];
}

/**
 * Sum the `(correct, hallucinated)` counters across every bucket for a given
 * agent + category whose `lastUpdateMs >= sinceMs`. Mirrors the contract of
 * `PerformanceReader.getCountersSince` so it can serve as a drop-in fast path.
 */
export function readCountersSince(
  data: SignalAggregateIndexData,
  agentId: string,
  category: string,
  sinceMs: number,
): { correct: number; hallucinated: number } {
  const result = { correct: 0, hallucinated: 0 };
  const cat = data.agents[agentId]?.[category];
  if (!cat) return result;
  for (const bucket of Object.values(cat)) {
    if (bucket.lastUpdateMs < sinceMs) continue;
    result.correct += bucket.correct;
    result.hallucinated += bucket.hallucinated;
  }
  return result;
}

/**
 * Rebuild the sidecar by folding every row of `agent-performance.jsonl` and
 * its rotated `.1` sibling. Skips `_system` tombstone rows and respects
 * `consensus_round_retracted` / `signal_retracted` so the rebuild matches
 * what `PerformanceReader.readSignalsRaw` would produce.
 *
 * `boundAtMs` per signal is taken from the signal's `_aggregate_bound_at_ms`
 * field when present (stamped by the writer at append time). Rows that
 * pre-date the sidecar shipping carry no such field — they fall back to the
 * signal's timestamp so they still land in a stable bucket.
 *
 * Mirrors `skill-index.ts` shape: pure function over disk, atomic write.
 */
export function rebuildAggregateIndex(projectRoot: string): SignalAggregateIndexData {
  const jsonlPath = join(projectRoot, '.gossip', AGENT_PERFORMANCE_FILENAME);
  const raw = readJsonlWithRotated(jsonlPath);
  const data = emptyData();
  if (!raw) {
    data.rebuiltAt = new Date().toISOString();
    writeAggregateIndex(projectRoot, data);
    return data;
  }

  const lines = raw.split('\n');
  const rows: ConsensusSignal[] = [];
  const retractedConsensusIds = new Set<string>();
  const retractedScoped = new Set<string>();
  const retractedWildcard = new Set<string>();

  for (const line of lines) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const row = parsed as ConsensusSignal & {
      consensus_id?: string;
      retractedSignal?: string;
    };
    if (row.type !== 'consensus') continue;
    if (typeof row.agentId !== 'string' || row.agentId.length === 0) continue;
    if (row.signal === 'consensus_round_retracted') {
      const cid = row.consensus_id;
      if (typeof cid === 'string' && cid.length > 0) retractedConsensusIds.add(cid);
      continue;
    }
    if (row.signal === 'signal_retracted') {
      const taskKey = row.taskId || row.timestamp;
      if (row.retractedSignal) {
        retractedScoped.add(`${row.agentId}:${taskKey}:${row.retractedSignal}`);
      } else {
        retractedWildcard.add(`${row.agentId}:${taskKey}`);
      }
      continue;
    }
    rows.push(row);
  }

  for (const row of rows) {
    if (row.agentId === '_system') continue;
    if (!row.category) continue;
    if (classifyForAggregate(row.signal) === 'none') continue;
    const taskKey = row.taskId || row.timestamp;
    if (retractedScoped.has(`${row.agentId}:${taskKey}:${row.signal}`)) continue;
    if (retractedWildcard.has(`${row.agentId}:${taskKey}`)) continue;
    const fid = row.findingId;
    if (typeof fid === 'string' && fid.length > 0) {
      let dropped = false;
      for (const cid of retractedConsensusIds) {
        if (fid.startsWith(cid + ':')) { dropped = true; break; }
      }
      if (dropped) continue;
    }
    const ts = row.timestamp ? new Date(row.timestamp).getTime() : 0;
    if (!isFinite(ts) || ts === 0) continue;
    const boundAtMs = readBoundAtFromRow(row, ts);
    foldSignal(data, row.agentId, row.category, boundAtMs, row.signal, ts);
  }

  for (const cid of retractedConsensusIds) recordRetraction(data, cid);

  data.rebuiltAt = new Date().toISOString();
  writeAggregateIndex(projectRoot, data);
  return data;
}

function readBoundAtFromRow(row: ConsensusSignal, fallbackMs: number): number {
  const stamped = (row as ConsensusSignal & { _aggregate_bound_at_ms?: unknown })
    ._aggregate_bound_at_ms;
  if (typeof stamped === 'number' && isFinite(stamped) && stamped > 0) return stamped;
  return fallbackMs;
}

/**
 * Detect whether the sidecar is stale relative to the live jsonl. Returns
 * `true` when:
 *   - the sidecar is missing, OR
 *   - the live jsonl mtime is newer than `lastRawTimestampMs`.
 *
 * A `true` result is the contract to call `rebuildAggregateIndex` before
 * trusting the sidecar.
 */
export function sidecarIsStale(
  projectRoot: string,
  data: SignalAggregateIndexData | null,
): boolean {
  if (!data) return true;
  const jsonlPath = join(projectRoot, '.gossip', AGENT_PERFORMANCE_FILENAME);
  let liveMtimeMs = 0;
  try {
    if (existsSync(jsonlPath)) liveMtimeMs = statSync(jsonlPath).mtimeMs;
  } catch {
    return true;
  }
  // `> ` so two appends in the same millisecond don't trigger spurious rebuilds.
  // The writer updates lastRawTimestampMs on every fold-in, so any append by a
  // sanctioned writer keeps the sidecar in step.
  return liveMtimeMs > data.lastRawTimestampMs + 1;
}

/**
 * Load the sidecar, rebuilding from raw if missing or stale. The returned
 * value is always non-null. Used by the read-side fast path.
 */
export function loadOrRebuildAggregateIndex(projectRoot: string): SignalAggregateIndexData {
  const existing = readAggregateIndex(projectRoot);
  if (!sidecarIsStale(projectRoot, existing) && existing) return existing;
  return rebuildAggregateIndex(projectRoot);
}
