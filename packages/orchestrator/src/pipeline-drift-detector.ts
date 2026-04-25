// packages/orchestrator/src/pipeline-drift-detector.ts
//
// Layer 3 signal-pipeline drift detector.
//
// Tails `.gossip/agent-performance.jsonl`, reads the `_emission_path` stamp
// on each row, and fires a `pipeline_drift_detected` diagnostic event when
// either:
//
//   (a) an allowlisted completion-signal name lands on a non-helper
//       emission path (**bypass**), OR
//   (b) rows land with `_emission_path === 'unknown'` above a tightened
//       rate threshold (**unknown-path**).
//
// The detector writes at most one row per detection to
// `.gossip/pipeline-drift.jsonl`, dedupes by offender fingerprint (so a
// single bypass doesn't produce an alert-storm as sampling repeats over
// overlapping windows), and escapes control characters in the log line
// so a hostile taskId cannot inject fake lines into `mcp.log`.
//
// The detector writes via its own `appendFileSync` — never through
// `PerformanceWriter`. Routing its own output through the sampled writer
// would re-trigger sampling and eventually recursion.
//
// See `docs/specs/2026-04-19-l3-signal-pipeline-drift-detector.md`.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  COMPLETION_SIGNAL_ALLOWLIST,
  COMPLETION_SIGNAL_AUTHORIZED_PATHS,
} from './completion-signals.allowlist';
import { rotateJsonlIfNeeded } from './performance-writer';

export interface DriftOffender {
  signal: string;
  emissionPath: string;
  taskId: string;
  agentId?: string;
}

export interface DriftDetectionResult {
  bypassCount: number;
  unknownCount: number;
  windowSize: number;
  postEpochCount: number;
  sampleOffenders: DriftOffender[];
  triggered: boolean;
  detectedAt?: string;
}

interface DriftState {
  tagEpochMs?: number;
  lastFingerprintSet?: string[];
}

export interface PipelineDriftDetectorOptions {
  /** Rolling window size in rows. Default 500. */
  windowSize?: number;
  /** Absolute bypass threshold (count of bypass rows in window). Default 1. */
  bypassThreshold?: number;
  /** Unknown-path rate threshold (0..1). Default 0.01 (1%). */
  unknownThresholdRate?: number;
  /**
   * Minimum post-epoch row count before unknown-rate is evaluated. Prevents
   * small-denominator false positives (e.g. 2/20 = 10%). Default 100.
   */
  minDenominator?: number;
  /** When false, `run()` is a no-op returning `triggered: false`. Default true. */
  enabled?: boolean;
}

const DEFAULTS = {
  windowSize: 500,
  bypassThreshold: 1,
  unknownThresholdRate: 0.01,
  minDenominator: 100,
  enabled: true,
};

const ALLOWLIST_SET = new Set<string>(COMPLETION_SIGNAL_ALLOWLIST);

/**
 * For an allowlisted signal, return the set of `_emission_path` values that
 * are sanctioned for it. Falls back to the canonical helper-only set when a
 * signal is in the allowlist but missing from the per-signal map (defensive —
 * the parity test should keep them aligned).
 */
function authorizedPathsFor(signal: string): ReadonlySet<string> {
  return (
    COMPLETION_SIGNAL_AUTHORIZED_PATHS[signal] ??
    new Set(['completion-signals-helper'])
  );
}

function fingerprint(offender: DriftOffender): string {
  return createHash('sha1')
    .update(`${offender.emissionPath}\x00${offender.signal}\x00${offender.taskId}`)
    .digest('hex');
}

/** Strip ASCII control characters (0x00–0x1f, 0x7f) from a string for log-line safety. */
function escapeControlChars(s: string): string {
  if (typeof s !== 'string') return String(s);
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, '?');
}

/**
 * Read up to `n` lines from the tail of `filePath`. If the primary file is
 * smaller than `n` lines, also merge the rotated `.1` sibling so rotation
 * immediately before a detection does not truncate the analysis window.
 */
function readTail(filePath: string, n: number): string[] {
  const lines: string[] = [];
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8');
      if (raw.length > 0) {
        const split = raw.split('\n').filter(l => l.length > 0);
        lines.push(...split);
      }
    }
  } catch {
    /* best-effort */
  }
  if (lines.length < n) {
    try {
      const rotated = filePath + '.1';
      if (existsSync(rotated)) {
        const raw = readFileSync(rotated, 'utf8');
        const split = raw.split('\n').filter(l => l.length > 0);
        // Older rows come from `.1`; prepend so they sort before primary.
        lines.unshift(...split);
      }
    } catch {
      /* best-effort */
    }
  }
  return lines.slice(-n);
}

export class PipelineDriftDetector {
  private readonly perfPath: string;
  private readonly driftPath: string;
  private readonly statePath: string;
  private readonly dir: string;
  private readonly opts: Required<PipelineDriftDetectorOptions>;

  constructor(projectRoot: string, options: PipelineDriftDetectorOptions = {}) {
    this.dir = join(projectRoot, '.gossip');
    this.perfPath = join(this.dir, 'agent-performance.jsonl');
    this.driftPath = join(this.dir, 'pipeline-drift.jsonl');
    this.statePath = join(this.dir, 'pipeline-drift.state');
    this.opts = {
      windowSize: options.windowSize ?? DEFAULTS.windowSize,
      bypassThreshold: options.bypassThreshold ?? DEFAULTS.bypassThreshold,
      unknownThresholdRate: options.unknownThresholdRate ?? DEFAULTS.unknownThresholdRate,
      minDenominator: options.minDenominator ?? DEFAULTS.minDenominator,
      enabled: options.enabled ?? DEFAULTS.enabled,
    };
  }

  /** Read the last detection row from `pipeline-drift.jsonl`, or null. */
  readLastReport(): DriftDetectionResult | null {
    try {
      if (!existsSync(this.driftPath)) return null;
      const raw = readFileSync(this.driftPath, 'utf8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      if (lines.length === 0) return null;
      const last = lines[lines.length - 1];
      const parsed = JSON.parse(last) as DriftDetectionResult;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Run the detector over the latest window of `agent-performance.jsonl`.
   * Always returns a result; only writes to disk when `triggered` is true
   * AND the offender-fingerprint set differs from the previous detection.
   */
  run(): DriftDetectionResult {
    const empty: DriftDetectionResult = {
      bypassCount: 0,
      unknownCount: 0,
      windowSize: 0,
      postEpochCount: 0,
      sampleOffenders: [],
      triggered: false,
    };
    if (!this.opts.enabled) return empty;

    let state: DriftState = this.readState();
    const rows = readTail(this.perfPath, this.opts.windowSize)
      .map(line => {
        try { return JSON.parse(line) as Record<string, unknown>; }
        catch { return null; }
      })
      .filter((r): r is Record<string, unknown> => r !== null);

    if (rows.length === 0) return { ...empty };

    // Establish or reuse the tagging-epoch timestamp. The epoch is the
    // earliest row in the jsonl that carries any `_emission_path` stamp —
    // rows before it predate L3 and must not count toward unknown-rate.
    let tagEpochMs = state.tagEpochMs;
    if (tagEpochMs === undefined) {
      for (const r of rows) {
        if (typeof r._emission_path === 'string') {
          const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
          if (isFinite(ts)) {
            tagEpochMs = ts;
            break;
          }
        }
      }
      if (tagEpochMs !== undefined) {
        state = { ...state, tagEpochMs };
        this.writeState(state);
      }
    }

    if (tagEpochMs === undefined) {
      // No tagged rows yet → detector is a no-op.
      return { ...empty, windowSize: rows.length };
    }

    const postEpoch = rows.filter(r => {
      const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
      return isFinite(ts) && ts >= (tagEpochMs as number);
    });

    // Bypass: allowlisted signal name on a path that is NOT in the
    // signal's authorized path set. Most signals only authorize
    // `completion-signals-helper`; a few (e.g. finding_dropped_format) have
    // an additional sanctioned secondary emit site declared in
    // COMPLETION_SIGNAL_AUTHORIZED_PATHS.
    const bypassRows = postEpoch.filter(r =>
      typeof r.signal === 'string'
      && ALLOWLIST_SET.has(r.signal)
      && typeof r._emission_path === 'string'
      && !authorizedPathsFor(r.signal).has(r._emission_path),
    );

    // Unknown: explicit 'unknown' emission-path (NOT "absent" — pre-epoch
    // rows are filtered out and all legitimate writers stamp the field).
    const unknownRows = postEpoch.filter(r => r._emission_path === 'unknown');

    const bypassCount = bypassRows.length;
    const unknownCount = unknownRows.length;
    const postEpochCount = postEpoch.length;

    const bypassTriggered = bypassCount >= this.opts.bypassThreshold;
    const unknownTriggered =
      postEpochCount >= this.opts.minDenominator
      && postEpochCount > 0
      && (unknownCount / postEpochCount) >= this.opts.unknownThresholdRate;

    const triggered = bypassTriggered || unknownTriggered;

    const offenders: DriftOffender[] = [...bypassRows, ...unknownRows]
      .slice(0, 4)
      .map(r => ({
        signal: String(r.signal ?? ''),
        emissionPath: String(r._emission_path ?? ''),
        taskId: String(r.taskId ?? ''),
        agentId: typeof r.agentId === 'string' ? r.agentId : undefined,
      }));

    const result: DriftDetectionResult = {
      bypassCount,
      unknownCount,
      windowSize: rows.length,
      postEpochCount,
      sampleOffenders: offenders,
      triggered,
    };

    if (!triggered) return result;

    // Dedupe against the previous detection's fingerprint set. Only persist
    // a new drift row when the offender set differs.
    const currentFps = new Set(offenders.map(o => fingerprint(o)));
    const prevFps = new Set(state.lastFingerprintSet ?? []);
    const identical = currentFps.size === prevFps.size
      && [...currentFps].every(fp => prevFps.has(fp));

    if (identical) return result;

    const detectedAt = new Date().toISOString();
    const row = { ...result, detectedAt };

    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      rotateJsonlIfNeeded(this.driftPath);
      appendFileSync(this.driftPath, JSON.stringify(row) + '\n');
    } catch (err) {
      try { process.stderr.write(`[gossipcat] drift jsonl write failed: ${(err as Error).message}\n`); }
      catch { /* best-effort */ }
    }

    try {
      const first = offenders[0];
      const safeSignal = first ? escapeControlChars(first.signal) : '';
      const safePath = first ? escapeControlChars(first.emissionPath) : '';
      const safeTask = first ? escapeControlChars(first.taskId) : '';
      const mcpLog = join(this.dir, 'mcp.log');
      appendFileSync(
        mcpLog,
        `[drift] bypass=${bypassCount}/${rows.length} unknown=${unknownCount}/${postEpochCount} first_offender={path=${safePath} signal=${safeSignal} task=${safeTask}}\n`,
      );
    } catch {
      /* best-effort */
    }

    this.writeState({ ...state, tagEpochMs, lastFingerprintSet: [...currentFps] });

    return { ...result, detectedAt };
  }

  private readState(): DriftState {
    try {
      if (!existsSync(this.statePath)) return {};
      const raw = readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as DriftState;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeState(next: DriftState): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
  }
}

// statSync is re-exported so the detector remains testable without pulling
// in the rest of performance-writer. Some test paths assert the detector
// survives a missing `.gossip/` directory; this keeps the import graph tidy.
void statSync;
