// packages/orchestrator/src/performance-writer.ts
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { PerformanceSignal } from './consensus-types';
import type { EmissionPath } from './completion-signals.allowlist';

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

const VALID_CONSENSUS_SIGNALS = new Set([
  'agreement', 'disagreement', 'unverified', 'unique_confirmed',
  'unique_unconfirmed', 'new_finding', 'hallucination_caught',
  'category_confirmed', 'consensus_verified', 'signal_retracted',
  'consensus_round_retracted',
  'task_timeout', 'task_empty',
  // Pre-existing runtime bug fix (spec §4, consensus 78bc92ef-23464bde:f11):
  // this signal was previously rejected by validateSignal and silently dropped.
  'severity_miscalibrated',
]);

const VALID_IMPL_SIGNALS = new Set([
  'impl_test_pass', 'impl_test_fail', 'impl_peer_approved', 'impl_peer_rejected',
]);

const VALID_META_SIGNALS = new Set([
  'task_completed', 'task_tool_turns', 'format_compliance',
]);

const VALID_PIPELINE_SIGNALS = new Set([
  'dispatch_started', 'relay_received', 'finding_dropped_format',
  'synthesis_completed', 'circuit_open_fired', 'skill_injection_skipped',
  'signal_retracted',
]);

/**
 * Sentinel agentId used on round-level tombstone rows. Not a real agent —
 * readers must skip `agentId === '_system'` rows from any per-agent
 * aggregation. See docs/specs/2026-04-17-consensus-round-retraction.md.
 */
const SYSTEM_SENTINEL_AGENT_ID = '_system';

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

const INTERNAL = Symbol('performance-writer-internal');

export class PerformanceWriter {
  private readonly filePath: string;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    const dir = join(projectRoot, '.gossip');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'agent-performance.jsonl');
    this.projectRoot = projectRoot;
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
      const row = { ...signal, _emission_path: emissionPath };
      appendFileSync(this.filePath, JSON.stringify(row) + '\n');
      bumpSampleCounter(this.projectRoot, 1);
    },

    /**
     * Append a batch of signals. See `appendSignal` for the `_emission_path`
     * contract.
     */
    appendSignals: (signals: PerformanceSignal[], emissionPath: EmissionPath = 'unknown'): void => {
      if (signals.length === 0) return;
      for (const s of signals) validateSignal(s);
      const data = signals
        .map(s => JSON.stringify({ ...s, _emission_path: emissionPath }))
        .join('\n') + '\n';
      rotateJsonlIfNeeded(this.filePath);
      appendFileSync(this.filePath, data);
      bumpSampleCounter(this.projectRoot, signals.length);
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
    validateSignal(row as PerformanceSignal);
    const stamped = { ...row, _emission_path: 'mcp-server-signals' as EmissionPath };
    appendFileSync(this.filePath, JSON.stringify(stamped) + '\n');
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
