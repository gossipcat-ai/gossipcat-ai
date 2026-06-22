// packages/orchestrator/src/performance-writer.ts
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { PerformanceSignal, ConsensusSignal, classifySignal } from './consensus-types';
import type { EmissionPath } from './completion-signals.allowlist';
import { bump as bumpRoundCounter, reset as resetRoundCounter, deriveConsensusId, makeBumpRecord } from './round-counter';
import {
  classifyForAggregate,
  foldSignal,
  readAggregateIndex,
  rebuildAggregateIndex,
  recordRetraction,
  sidecarIsStale,
  writeAggregateIndex,
  SIDECAR_VERSION,
  type SignalAggregateIndexData,
} from './signal-aggregate-index';
import { readSkillFreshness } from './skill-freshness';

/**
 * Fix 5 (spec 2026-04-27-self-telemetry-remediation §Fix 5): rate-limited
 * stderr logging for round-counter bump errors. Logs once per unique error
 * message per process lifetime so a persistent failure (e.g. regex regression
 * in deriveConsensusId) is observable without flooding stderr.
 */
const loggedCounterErrors = new Set<string>();

export type { EmissionPath } from './completion-signals.allowlist';

/**
 * Max bytes before single-slot rotation of telemetry JSONL files.
 * Matches the convention in apps/cli/src/sandbox.ts (boundary-escapes.jsonl).
 */
export const MAX_TELEMETRY_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Best-effort single-slot size rotation. If `filePath` is at least `maxBytes`,
 * rename it to `filePath + '.1'` (overwriting any pre-existing `.1`). No
 * `.2`/`.3`, no compression. Silent on any error.
 */
export function rotateJsonlIfNeeded(filePath: string, maxBytes: number = MAX_TELEMETRY_BYTES): void {
  try {
    const st = statSync(filePath);
    if (st.size < maxBytes) return;
    renameSync(filePath, filePath + '.1');
  } catch {
    /* file missing or unrenamable — caller's next append re-creates the primary slot */
  }
}

export const VALID_CONSENSUS_SIGNALS = new Set([
  'agreement', 'disagreement', 'unverified', 'unique_confirmed',
  'unique_unconfirmed', 'new_finding', 'hallucination_caught',
  'category_confirmed', 'consensus_verified', 'signal_retracted',
  'consensus_round_retracted',
  'task_timeout', 'task_empty',
  // Pre-existing runtime bug fix (spec §4, consensus 78bc92ef-23464bde:f11):
  // this signal was previously rejected by validateSignal and silently dropped.
  'severity_miscalibrated',
  // Emitted by consensus-engine when relay cross-review coverage drops;
  // previously rejected by validateSignal and silently dropped.
  'consensus_coverage_degraded',
  // Sandbox policy violation — recorded for observability, zero weight in scoring.
  // Consensus round bb03845d-64264402 (7/7 confirmed).
  'boundary_escape',
  // Transport-layer failure (relay-worker resolutionRoots gap, missing/deleted
  // worktree, cwd misrouting). Excluded from accuracy/uniqueness arithmetic
  // per performance-reader.ts:950 + L75. Pre-PR #329: rejected by validateSignal
  // and silently dropped, masking the fail-closed signal emit added in PR #328.
  'transport_failure',
  // Native-worktree isolation gap detector (spec
  // docs/specs/2026-05-20-native-worktree-isolation-fix.md). Emitted when an
  // Agent(isolation:"worktree") dispatch leaves the parent checkout with moved
  // HEAD or new dirty paths. Operational signal — zero weight in scoring.
  'worktree_isolation_failed',
  // Consensus auto-verify (spec docs/superpowers/specs/2026-05-21-consensus-auto-verify-design.md,
  // approved rev-6). Operational signals emitted by maybeAutoVerify — zero weight
  // in scoring. Without these entries the allowlist-drift test fails and
  // validateSignal silently drops every emit (same failure mode as PR #329 for
  // transport_failure).
  'auto_verify_attempted',
  'auto_verify_skipped_misconfigured',
]);

export const VALID_IMPL_SIGNALS = new Set([
  'impl_test_pass', 'impl_test_fail', 'impl_peer_approved', 'impl_peer_rejected',
]);

export const VALID_META_SIGNALS = new Set([
  'task_completed', 'task_tool_turns', 'format_compliance',
]);

export const VALID_PIPELINE_SIGNALS = new Set([
  'dispatch_started', 'relay_received', 'finding_dropped_format',
  'synthesis_completed', 'circuit_open_fired', 'skill_injection_skipped',
  'signal_retracted', 'citation_fabricated',
  // Path A relay-lint (PR #270, consensus-reviewed): emitted when a native
  // task that was part of an active consensus round arrives via gossip_relay
  // with zero <agent_finding> tags — indicates the orchestrator paraphrased
  // instead of pasting verbatim, dropping all findings. Pre-fix: validateSignal
  // threw on this name and the catch silently swallowed every emission.
  'relay_findings_dropped',
  // Phase A self-telemetry: collect-end reconciliation detected fewer signals
  // written than findings in the consensus report. Observability-only.
  'signal_loss_suspected',
]);

/**
 * Sentinel agentId used on round-level tombstone rows. Not a real agent —
 * readers must skip `agentId === '_system'` rows from any per-agent
 * aggregation. See docs/specs/2026-04-17-consensus-round-retraction.md.
 */
const SYSTEM_SENTINEL_AGENT_ID = '_system';

/**
 * Stamp `signal_class` onto the signal if not already set (PR 5 / Option 5B,
 * 2026-04-21). Write-forward only — existing rows in agent-performance.jsonl
 * are not backfilled, and any explicit `signal_class` on the input is
 * preserved. When `classifySignal` returns `undefined` (signal name not yet
 * categorised) the field is left unset rather than assigned a default — the
 * field remains genuinely optional so consumers can distinguish "unknown" from
 * "known performance/operational".
 */
function stampSignalClass<T extends PerformanceSignal>(signal: T): T {
  if (signal.signal_class !== undefined) return signal;
  const cls = classifySignal(signal.signal);
  if (cls === undefined) return signal;
  return { ...signal, signal_class: cls };
}

function validateSignal(signal: PerformanceSignal): void {
  if (!signal || typeof signal !== 'object') {
    throw new Error('Signal validation failed: signal must be an object');
  }
  if (typeof signal.agentId !== 'string' || signal.agentId.length === 0) {
    throw new Error('Signal validation failed: agentId must be a non-empty string');
  }
  if (typeof signal.taskId !== 'string' || signal.taskId.length === 0) {
    throw new Error('Signal validation failed: taskId must be a non-empty string');
  }
  if (typeof signal.timestamp !== 'string' || !isFinite(new Date(signal.timestamp).getTime())) {
    throw new Error('Signal validation failed: timestamp must be a valid ISO-8601 string');
  }

  switch (signal.type) {
    case 'consensus':
      if (!VALID_CONSENSUS_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown consensus signal "${signal.signal}"`);
      }
      break;
    case 'impl':
      if (!VALID_IMPL_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown impl signal "${signal.signal}"`);
      }
      break;
    case 'meta':
      if (!VALID_META_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown meta signal "${signal.signal}"`);
      }
      break;
    case 'pipeline':
      if (!VALID_PIPELINE_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown pipeline signal "${signal.signal}"`);
      }
      break;
    default:
      throw new Error(`Signal validation failed: unknown type "${(signal as any).type}"`);
  }
}


/**
 * Module-level sampling counter for the L3 drift detector. Reset on process
 * exit (documented as "best-effort on long-lived processes") — the epoch and
 * fingerprint cache persist to `.gossip/pipeline-drift.state` so detection
 * survives CLI restarts even if the in-memory counter does not.
 */
let rowsWrittenSinceCheck = 0;
const DRIFT_SAMPLE_INTERVAL = 50;

function bumpSampleCounter(projectRoot: string, delta: number): void {
  rowsWrittenSinceCheck += delta;
  if (rowsWrittenSinceCheck < DRIFT_SAMPLE_INTERVAL) return;
  rowsWrittenSinceCheck = 0;
  // Lazy import keeps the circular-dependency risk off the hot path and lets
  // the detector be tree-shaken if it evolves into optional telemetry.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PipelineDriftDetector } = require('./pipeline-drift-detector') as {
      PipelineDriftDetector: new (projectRoot: string) => { run(): unknown };
    };
    new PipelineDriftDetector(projectRoot).run();
  } catch (err) {
    try {
      process.stderr.write(`[gossipcat] pipeline drift sampling failed: ${(err as Error).message}\n`);
    } catch { /* best-effort */ }
  }
}

/**
 * Reset the module-level sampling counter. Intended for unit tests that need
 * deterministic control over when the L3 detector runs.
 * @internal
 */
export function __resetSampleCounterForTests(): void {
  rowsWrittenSinceCheck = 0;
}

/**
 * Reset the module-level set of already-logged counter-error messages.
 * Intended for unit tests (Fix 5) that verify deduplication behaviour and
 * need to start each test from a clean slate.
 * @internal
 */
export function __resetLoggedCounterErrorsForTests(): void {
  loggedCounterErrors.clear();
}

const INTERNAL = Symbol('performance-writer-internal');

/**
 * Resolve a (boundAtMs, signalForAggregate) pair for a consensus signal that
 * should contribute to the sidecar. Returns null when:
 *   - the signal is not a per-agent accuracy signal (operational / unknown), OR
 *   - the signal carries no `category` (sidecar partitions by category), OR
 *   - the signal's agent is the `_system` sentinel (round-level tombstone).
 */
function deriveAggregateKey(
  signal: PerformanceSignal,
  projectRoot: string,
  boundAtCache: Map<string, number>,
): { agentId: string; category: string; boundAtMs: number; signal: string; timestampMs: number } | null {
  if (signal.type !== 'consensus') return null;
  const cs = signal as ConsensusSignal;
  if (cs.agentId === '_system') return null;
  if (!cs.category) return null;
  if (classifyForAggregate(cs.signal) === 'none') return null;
  const ts = cs.timestamp ? new Date(cs.timestamp).getTime() : 0;
  if (!isFinite(ts) || ts === 0) return null;
  const boundAtMs = resolveBoundAtMs(cs.agentId, cs.category, projectRoot, boundAtCache, ts);
  return {
    agentId: cs.agentId,
    category: cs.category,
    boundAtMs,
    signal: cs.signal,
    timestampMs: ts,
  };
}

/**
 * Look up the `bound_at` for an agent's category-skill file, with per-process
 * caching so the sidecar fold-in doesn't disk-walk on every signal. Falls
 * back to the signal timestamp when no skill file exists — the signal still
 * lands in a stable bucket, just keyed by its own arrival time. The cache is
 * pessimistic about freshness: a rebound skill won't be picked up mid-process
 * but the sidecar carries an explicit `_aggregate_bound_at_ms` stamp on every
 * jsonl row so a rebuild always sees the same boundary the writer used.
 */
const boundAtMissSentinel = -1;
function resolveBoundAtMs(
  agentId: string,
  category: string,
  projectRoot: string,
  cache: Map<string, number>,
  fallbackMs: number,
): number {
  const key = agentId + ' ' + category;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached === boundAtMissSentinel ? fallbackMs : cached;
  }
  try {
    const { boundAt } = readSkillFreshness(agentId, category, projectRoot);
    if (typeof boundAt === 'string' && boundAt.length > 0) {
      const ms = new Date(boundAt).getTime();
      if (isFinite(ms) && ms > 0) {
        cache.set(key, ms);
        return ms;
      }
    }
  } catch {
    /* fall through to sentinel */
  }
  cache.set(key, boundAtMissSentinel);
  return fallbackMs;
}

export class PerformanceWriter {
  private readonly filePath: string;
  private readonly projectRoot: string;
  // Per-instance bound-at cache: agentId\0category → boundAtMs (or -1 sentinel
  // for "no skill file"). Bounded by the agent×category cardinality of a
  // single process — small in practice (<50 entries even for big fleets).
  private readonly boundAtCache: Map<string, number> = new Map();

  constructor(projectRoot: string) {
    const dir = join(projectRoot, '.gossip');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'agent-performance.jsonl');
    this.projectRoot = projectRoot;
  }

  /**
   * Fold one or more signals into the aggregate sidecar AFTER the jsonl
   * append succeeded. Errors are swallowed and logged — the raw jsonl is the
   * system of record; sidecar staleness is detected and repaired on read.
   *
   * Visible for testing.
   * @internal
   */
  __updateAggregateSidecar(signals: PerformanceSignal[]): void {
    if (signals.length === 0) return;
    // Read existing sidecar (do NOT rebuild here — we already wrote the
    // signals to jsonl, so any rebuild would double-count when we apply our
    // delta below). If the on-disk sidecar is stale relative to the live
    // jsonl, that means another writer or a prior crash left rows that we
    // didn't fold in. Rebuild once to catch up to the live jsonl mtime
    // BEFORE adding our delta — but only if the staleness pre-dates our
    // current append. Race-safe enough because writes are single-process.
    let data: SignalAggregateIndexData;
    try {
      const existing = readAggregateIndex(this.projectRoot);
      if (existing && !sidecarIsStale(this.projectRoot, existing)) {
        data = existing;
      } else if (existing) {
        // Stale: rebuild from raw (which includes the rows we just wrote)
        // then DON'T apply our delta — the rebuild already saw it. Short-
        // circuit so we don't double count.
        rebuildAggregateIndex(this.projectRoot);
        return;
      } else {
        // No sidecar yet: start fresh and let our delta be the seed. This
        // path also runs on first-ever signal — jsonl has 1 row, sidecar is
        // about to be created from the delta below.
        data = {
          version: SIDECAR_VERSION,
          rebuiltAt: new Date(0).toISOString(),
          lastRawTimestampMs: 0,
          agents: {},
        };
      }
    } catch (err) {
      try {
        process.stderr.write(`[gossipcat] signal-aggregate-sidecar load failed: ${(err as Error).message}\n`);
      } catch { /* best-effort */ }
      return;
    }
    let mutated = false;
    for (const s of signals) {
      if (s.type === 'consensus' && (s as ConsensusSignal).signal === 'consensus_round_retracted') {
        const cid = (s as ConsensusSignal & { consensus_id?: string }).consensus_id;
        if (typeof cid === 'string' && cid.length > 0) {
          if (recordRetraction(data, cid) > 0) mutated = true;
        }
        continue;
      }
      const key = deriveAggregateKey(s, this.projectRoot, this.boundAtCache);
      if (!key) continue;
      if (foldSignal(data, key.agentId, key.category, key.boundAtMs, key.signal, key.timestampMs)) {
        mutated = true;
      }
    }
    if (!mutated) return;
    data.rebuiltAt = new Date().toISOString();
    // Track the live jsonl mtime so sidecarIsStale() stays in step with the
    // file we just appended to. Without this, every subsequent appendFileSync
    // bumps the mtime past lastRawTimestampMs (which is signal-timestamp-
    // based and ~equal to wall time but not identical), spuriously marking
    // the sidecar stale and forcing a full rebuild on every other write.
    try {
      const st = statSync(this.filePath);
      if (st.mtimeMs > data.lastRawTimestampMs) data.lastRawTimestampMs = st.mtimeMs;
    } catch { /* best-effort */ }
    writeAggregateIndex(this.projectRoot, data);
  }

  /**
   * @internal — test-only reset of the bound-at cache. Mutators don't expose
   * the cache directly; tests that re-bind skills mid-test need this to
   * observe the new timestamp without spinning up a fresh writer.
   */
  __resetBoundAtCacheForTests(): void {
    this.boundAtCache.clear();
  }

  /**
   * Package-internal signal writer, gated by a non-exported Symbol.
   *
   * External callers CANNOT access these methods via plain property access —
   * `appendSignal` and `appendSignals` are no longer public properties on
   * `PerformanceWriter`. Only code that imports `WRITER_INTERNAL` from
   * `_writer-internal.ts` can call them, and that import is enforced by the
   * Step 4 parity test (Layer 1).
   *
   * Access pattern (sanctioned callers only):
   *   import { WRITER_INTERNAL } from './_writer-internal.js';
   *   writer[WRITER_INTERNAL].appendSignal(signal, emissionPath);
   *
   * No `as any` cast is required — TypeScript resolves the Symbol key to
   * this object type at compile time. (spec §2, consensus 78bc92ef-23464bde:f9)
   */
  [INTERNAL] = {
    /**
     * Append a single signal. Stamps `_emission_path` on the serialised row
     * (out-of-band from the validated signal envelope) so the L3 drift
     * detector can distinguish bypass writers from the sanctioned helper path.
     * `_emission_path` defaults to `'unknown'` — any unset call site shows up
     * as drift to the detector.
     */
    appendSignal: (signal: PerformanceSignal, emissionPath: EmissionPath = 'unknown'): void => {
      validateSignal(signal);
      rotateJsonlIfNeeded(this.filePath);
      const stamped = stampSignalClass(signal);
      // Stamp the resolved aggregate boundAt on the row so a rebuild folds
      // signals into the same bucket the live write path used. No-op when the
      // signal carries no category — see deriveAggregateKey for the contract.
      const aggKey = deriveAggregateKey(stamped, this.projectRoot, this.boundAtCache);
      const row = aggKey
        ? { ...stamped, _emission_path: emissionPath, _aggregate_bound_at_ms: aggKey.boundAtMs }
        : { ...stamped, _emission_path: emissionPath };
      // Option C (spec 2026-04-27-self-telemetry-crash-consistency): build the
      // counter-bump meta-record and concatenate it with the signal payload so
      // both land in a single appendFileSync call. This eliminates the
      // two-file split-write window where a crash between the signal write and
      // the counter bump could orphan one or the other.
      //
      // Fix 4 (spec 2026-04-27-self-telemetry-remediation §Fix 4) is preserved:
      // operational signals do not contribute a bump record. classifySignal
      // returning undefined is preserved as performance-equivalent (backwards
      // compat for unknown signal names).
      let payload = JSON.stringify(row) + '\n';
      try {
        const cls = classifySignal(signal.signal);
        if (cls === undefined || cls === 'performance') {
          const cid = deriveConsensusId(signal as { consensusId?: string; findingId?: string });
          if (cid) {
            const bumpRec = makeBumpRecord(cid, emissionPath);
            payload += JSON.stringify(bumpRec) + '\n';
          }
        }
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (!loggedCounterErrors.has(msg)) {
          loggedCounterErrors.add(msg);
          try {
            process.stderr.write(`[gossipcat] round-counter bump failed: ${msg}\n`);
          } catch { /* best-effort */ }
        }
      }
      // If the JSONL write fails (read-only fs, EPERM, ENOSPC, etc.), register
      // the bump via bumpRoundCounter() so get() can still report in-process
      // work via inMemoryFallback. Re-throw so the caller knows persistence
      // failed — the contract is: counter is best-effort, error visibility is
      // mandatory.
      try {
        appendFileSync(this.filePath, payload);
      } catch (writeErr) {
        const cid = deriveConsensusId(signal as { consensusId?: string; findingId?: string });
        if (cid) {
          try {
            // bump() catches its own JSONL error and falls through to
            // inMemoryFallback — so on a read-only fs this is a no-op write
            // plus an in-memory register. No double-bump: the payload that
            // failed to land never contributed a JSONL record.
            bumpRoundCounter(this.projectRoot, cid);
          } catch { /* best-effort */ }
        }
        throw writeErr;
      }
      bumpSampleCounter(this.projectRoot, 1);
      // Sidecar fold-in is best-effort: jsonl is the system of record.
      try { this.__updateAggregateSidecar([stamped]); } catch { /* logged inside */ }
    },

    /**
     * Append a batch of signals. See `appendSignal` for the `_emission_path`
     * contract.
     */
    appendSignals: (signals: PerformanceSignal[], emissionPath: EmissionPath = 'unknown'): void => {
      if (signals.length === 0) return;
      for (const s of signals) validateSignal(s);
      // Option C: interleave each signal payload with its counter-bump
      // meta-record (when applicable) into a single appendFileSync call. The
      // signal and its bump cannot split across a crash boundary because they
      // are part of the same write(2). Per-iteration try/catch preserves the
      // Cosmetic-B invariant that one bad signal does not abort the rest of
      // the batch (PR #5: feedback_signal_serialization_defer style).
      const parts: string[] = [];
      const stampedSignals: PerformanceSignal[] = [];
      for (const s of signals) {
        const stamped = stampSignalClass(s);
        stampedSignals.push(stamped);
        const aggKey = deriveAggregateKey(stamped, this.projectRoot, this.boundAtCache);
        const row = aggKey
          ? { ...stamped, _emission_path: emissionPath, _aggregate_bound_at_ms: aggKey.boundAtMs }
          : { ...stamped, _emission_path: emissionPath };
        parts.push(JSON.stringify(row));
        try {
          const cls = classifySignal(s.signal);
          if (cls !== undefined && cls !== 'performance') continue;
          const cid = deriveConsensusId(s as { consensusId?: string; findingId?: string });
          if (cid) {
            const bumpRec = makeBumpRecord(cid, emissionPath);
            parts.push(JSON.stringify(bumpRec));
          }
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          if (!loggedCounterErrors.has(msg)) {
            loggedCounterErrors.add(msg);
            try {
              process.stderr.write(`[gossipcat] round-counter bump failed: ${msg}\n`);
            } catch { /* best-effort */ }
          }
        }
      }
      const data = parts.join('\n') + '\n';
      rotateJsonlIfNeeded(this.filePath);
      // If the JSONL write fails (read-only fs, EPERM, ENOSPC, etc.), register
      // bumps via bumpRoundCounter() so get() can still report in-process work
      // via inMemoryFallback for each signal that had a derivable consensusId.
      // Re-throw so the caller knows persistence failed.
      try {
        appendFileSync(this.filePath, data);
      } catch (writeErr) {
        for (const s of signals) {
          const cid = deriveConsensusId(s as { consensusId?: string; findingId?: string });
          if (cid) {
            const cls = classifySignal(s.signal);
            if (cls === undefined || cls === 'performance') {
              try { bumpRoundCounter(this.projectRoot, cid); } catch { /* best-effort */ }
            }
          }
        }
        throw writeErr;
      }
      bumpSampleCounter(this.projectRoot, signals.length);
      try { this.__updateAggregateSidecar(stampedSignals); } catch { /* logged inside */ }
    },
  };

  /**
   * @internal — sanctioned escape hatch for consensus-round retraction.
   * Writes a `_system`-agent sentinel row that does NOT follow the normal
   * signal envelope (see 2026-04-17-consensus-round-retraction.md).
   * The Step 4 parity test allowlists this one call site by method name
   * (`PerformanceWriter.recordConsensusRoundRetraction`). No new methods
   * may be added to that allowlist without an explicit consensus decision.
   *
   * Note: this method DOES call `validateSignal`, so it is not a raw writer.
   * It skips `appendSignal(s)` and `bumpSampleCounter` — meaning the L3
   * drift detector gets no sample tick from retraction events (pre-existing,
   * documented in consensus fb3ea8fc-6e674462:f16/f20).
   *
   * Tombstone row uses the `_system` sentinel as `agentId`. Readers must
   * filter `agentId === '_system'` out of per-agent aggregation; signal
   * scoring uses `consensus_id` to drop every signal whose `findingId`
   * starts with `<consensus_id>:`. Idempotence is a reader concern — extra
   * rows from duplicate retractions are harmless audit data that the
   * reader's `retractedConsensusIds: Set<string>` dedupes.
   *
   * See docs/specs/2026-04-17-consensus-round-retraction.md.
   */
  recordConsensusRoundRetraction(consensusId: string, reason: string): void {
    const row: any = {
      type: 'consensus',
      signal: 'consensus_round_retracted',
      agentId: SYSTEM_SENTINEL_AGENT_ID,
      // taskId is required by validateSignal. Mirror consensus_id so
      // the tombstone is structurally addressable without inventing a
      // second identifier.
      taskId: consensusId,
      consensus_id: consensusId,
      reason,
      retracted_at: new Date().toISOString(),
      timestamp: new Date().toISOString(),
      evidence: `Consensus round ${consensusId} retracted: ${reason}`,
    };
    const classStamped = stampSignalClass(row as PerformanceSignal);
    validateSignal(classStamped);
    const stamped = { ...classStamped, _emission_path: 'mcp-server-signals' as EmissionPath };
    // Fix 2 (spec 2026-04-27-self-telemetry-remediation §Fix 2): drop the
    // accumulated round counter for this consensusId. The retraction tombstone
    // does not itself bump the counter (preserving the documented invariant
    // that retraction skips appendSignal/bumpSampleCounter), but the round is
    // dead — leaving the counter at N would compare against the now-empty
    // findingsAll on the next collect() and emit a false-positive
    // signal_loss_suspected. Non-fatal: persistence errors (read-only fs,
    // missing file) must not break the retract path.
    //
    // try/finally ensures resetRoundCounter runs even if appendFileSync throws
    // (e.g. disk full, EPERM). The counter must be cleared unconditionally so a
    // failed tombstone write does not leave a stale count that generates a
    // false-positive signal_loss_suspected on the next collect().
    try {
      appendFileSync(this.filePath, JSON.stringify(stamped) + '\n');
    } finally {
      try { resetRoundCounter(this.projectRoot, consensusId); } catch { /* non-fatal */ }
      // Sidecar retraction: propagate the consensus_id into every bucket so
      // readers can short-circuit `findingId.startsWith(cid + ':')` checks
      // when computing accuracy from the fast path. Errors logged inside.
      try { this.__updateAggregateSidecar([stamped as PerformanceSignal]); } catch { /* logged */ }
    }
  }
}

/**
 * Re-export the Symbol that gates `appendSignal(s)` access for signal helpers.
 *
 * This export is intentionally NOT re-exported from `packages/orchestrator/src/index.ts`.
 * It is only accessible via `packages/orchestrator/src/_writer-internal.ts`.
 * The Step 4 parity test enforces this boundary.
 *
 * Consensus rounds 78bc92ef-23464bde and fb3ea8fc-6e674462 established this boundary.
 */
export { INTERNAL as _WRITER_INTERNAL_FOR_HELPERS_ONLY };
