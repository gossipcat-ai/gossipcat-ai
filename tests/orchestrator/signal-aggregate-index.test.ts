// @gossip:impact-adjacent:signal_pipeline
/**
 * Phase B — signal-aggregate sidecar.
 *
 * Spec: docs/specs/2026-05-13-signal-log-aggregate-sidecar.md (gitignored).
 * Followup to PR #367 (commit 6644cba).
 *
 * Mandatory test categories (per spec §Tests):
 *   1. concurrent write-while-rebuild
 *   2. retraction propagation
 *   3. rotation mid-scan
 *   4. crash simulation (jsonl appended but sidecar not — verify rebuild detects)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadOrRebuildAggregateIndex,
  rebuildAggregateIndex,
  readAggregateIndex,
  readCountersSince,
  recordRetraction,
  sidecarIsStale,
  foldSignal,
  SIDECAR_FILENAME,
  SIDECAR_VERSION,
  type SignalAggregateIndexData,
} from '../../packages/orchestrator/src/signal-aggregate-index';
import { PerformanceWriter } from '../../packages/orchestrator/src/performance-writer';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';
import type { PerformanceSignal } from '../../packages/orchestrator/src/consensus-types';

let tmpDir: string;
let gossipDir: string;
let jsonlPath: string;
let sidecarPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gossip-sidecar-test-'));
  gossipDir = join(tmpDir, '.gossip');
  mkdirSync(gossipDir, { recursive: true });
  jsonlPath = join(gossipDir, 'agent-performance.jsonl');
  sidecarPath = join(gossipDir, SIDECAR_FILENAME);
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

function makeSignal(
  agentId: string,
  signal: PerformanceSignal['signal'],
  opts: { category?: string; taskId?: string; consensusId?: string; findingId?: string; daysAgo?: number } = {},
): PerformanceSignal {
  const tsMs = Date.now() - (opts.daysAgo ?? 0) * 86400000;
  const sig: any = {
    type: 'consensus',
    agentId,
    signal,
    taskId: opts.taskId ?? 't-' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date(tsMs).toISOString(),
    evidence: 'test',
  };
  if (opts.category) sig.category = opts.category;
  if (opts.consensusId) sig.consensusId = opts.consensusId;
  if (opts.findingId) sig.findingId = opts.findingId;
  return sig as PerformanceSignal;
}

// ── Schema + classify ────────────────────────────────────────────────────────

describe('sidecar schema', () => {
  it('reads back exact schema fields', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('a-1', 'agreement', { category: 'security' }));

    const raw = readFileSync(sidecarPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(SIDECAR_VERSION);
    expect(typeof parsed.rebuiltAt).toBe('string');
    expect(typeof parsed.lastRawTimestampMs).toBe('number');
    expect(parsed.agents['a-1'].security).toBeDefined();
    const buckets = Object.values(parsed.agents['a-1'].security) as any[];
    expect(buckets[0].correct).toBe(1);
    expect(buckets[0].hallucinated).toBe(0);
    expect(buckets[0].total).toBe(1);
    expect(buckets[0].lastUpdateMs).toBeGreaterThan(0);
    expect(Array.isArray(buckets[0].recentRetractedConsensusIds)).toBe(true);
  });

  it('skips signals without category (sidecar partitions by category)', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('a-2', 'agreement')); // no category
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it('skips _system tombstone-style rows on fold', () => {
    const writer = new PerformanceWriter(tmpDir);
    // Seed with one real signal so the retraction has something to propagate
    // into. A retraction on an empty sidecar is a no-op (no buckets to touch).
    writer[WRITER_INTERNAL].appendSignal(
      makeSignal('agent-real', 'agreement', { category: 'security' }),
    );
    writer.recordConsensusRoundRetraction('cid-x', 'test');
    expect(existsSync(sidecarPath)).toBe(true);
    const data = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    expect(data.agents._system).toBeUndefined();
    // The real-agent bucket should now have the retracted consensus_id
    const bucket = Object.values(data.agents['agent-real'].security)[0] as any;
    expect(bucket.recentRetractedConsensusIds).toContain('cid-x');
  });
});

// ── Write-time fold-in via PerformanceWriter ────────────────────────────────

describe('PerformanceWriter sidecar fold-in', () => {
  it('appendSignal updates sidecar after jsonl append', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-a', 'agreement', { category: 'security' }));
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-a', 'hallucination_caught', { category: 'security' }));

    const data = readAggregateIndex(tmpDir);
    expect(data).not.toBeNull();
    const counters = readCountersSince(data!, 'agent-a', 'security', 0);
    expect(counters.correct).toBe(1);
    expect(counters.hallucinated).toBe(1);
  });

  it('appendSignals batch fold updates sidecar exactly once with correct counters', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignals([
      makeSignal('agent-b', 'agreement', { category: 'security' }),
      makeSignal('agent-b', 'agreement', { category: 'security' }),
      makeSignal('agent-b', 'hallucination_caught', { category: 'concurrency' }),
    ]);
    const data = readAggregateIndex(tmpDir)!;
    expect(readCountersSince(data, 'agent-b', 'security', 0)).toEqual({ correct: 2, hallucinated: 0 });
    expect(readCountersSince(data, 'agent-b', 'concurrency', 0)).toEqual({ correct: 0, hallucinated: 1 });
  });

  it('operational signals (task_timeout, transport_failure, boundary_escape) do not fold', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignals([
      makeSignal('agent-c', 'task_timeout', { category: 'security' }),
      makeSignal('agent-c', 'transport_failure', { category: 'security' }),
      makeSignal('agent-c', 'boundary_escape', { category: 'security' }),
    ]);
    // jsonl was written (3 rows), but sidecar should have no agent-c bucket
    expect(existsSync(jsonlPath)).toBe(true);
    const data = readAggregateIndex(tmpDir);
    expect(data?.agents['agent-c']).toBeUndefined();
  });

  it('sidecar write failure does not break jsonl append', () => {
    const writer = new PerformanceWriter(tmpDir);
    // Pre-create sidecar path as a directory to force write failure
    mkdirSync(sidecarPath, { recursive: true });
    expect(() =>
      writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-d', 'agreement', { category: 'security' })),
    ).not.toThrow();
    // jsonl write succeeded
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
  });
});

// ── Reader fast path migration: getCountersSince ────────────────────────────

describe('PerformanceReader.getCountersSince uses sidecar fast path', () => {
  it('returns identical counters as raw-scan when sidecar is fresh', () => {
    const writer = new PerformanceWriter(tmpDir);
    const sig1 = makeSignal('agent-e', 'agreement', { category: 'security' });
    const sig2 = makeSignal('agent-e', 'hallucination_caught', { category: 'security' });
    writer[WRITER_INTERNAL].appendSignals([sig1, sig2]);

    const reader = new PerformanceReader(tmpDir);
    const counters = reader.getCountersSince('agent-e', 'security', 0);
    expect(counters.correct).toBe(1);
    expect(counters.hallucinated).toBe(1);
  });

  it('falls back to raw scan when sidecar is missing', () => {
    // Write rows directly without using PerformanceWriter (no sidecar)
    const ts = new Date().toISOString();
    appendFileSync(jsonlPath, JSON.stringify({
      type: 'consensus', agentId: 'agent-f', signal: 'agreement',
      category: 'security', taskId: 't1', timestamp: ts, evidence: 'x',
    }) + '\n');
    expect(existsSync(sidecarPath)).toBe(false);

    const reader = new PerformanceReader(tmpDir);
    const counters = reader.getCountersSince('agent-f', 'security', 0);
    expect(counters.correct).toBe(1);
  });

  it('falls back to raw scan when sidecar is stale', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-g', 'agreement', { category: 'security' }));

    // Simulate post-crash state: append a new row to jsonl WITHOUT updating sidecar.
    const futureTs = new Date(Date.now() + 5000).toISOString();
    appendFileSync(jsonlPath, JSON.stringify({
      type: 'consensus', agentId: 'agent-g', signal: 'agreement',
      category: 'security', taskId: 't2', timestamp: futureTs, evidence: 'x',
    }) + '\n');
    // Force the jsonl mtime forward so sidecarIsStale fires (some filesystems
    // give us identical mtime for two writes inside one millisecond).
    const future = new Date(Date.now() + 10000);
    utimesSync(jsonlPath, future, future);

    const data = readAggregateIndex(tmpDir);
    expect(sidecarIsStale(tmpDir, data)).toBe(true);

    const reader = new PerformanceReader(tmpDir);
    const counters = reader.getCountersSince('agent-g', 'security', 0);
    // Raw-scan sees both rows: 2 correct
    expect(counters.correct).toBe(2);
  });
});

// ── Mandatory category 1: concurrent write-while-rebuild ────────────────────

describe('concurrent write-while-rebuild', () => {
  it('rebuild while writer appends does not lose either signal', () => {
    // Seed with one signal
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-h', 'agreement', { category: 'security' }));

    // Simulate a parallel writer appending mid-rebuild: write the jsonl row
    // BEFORE rebuild reads, then verify rebuild reflects it.
    const futureTs = new Date(Date.now() + 1000).toISOString();
    appendFileSync(jsonlPath, JSON.stringify({
      type: 'consensus', agentId: 'agent-h', signal: 'agreement',
      category: 'security', taskId: 't-concurrent', timestamp: futureTs, evidence: 'x',
    }) + '\n');

    const rebuilt = rebuildAggregateIndex(tmpDir);
    const counters = readCountersSince(rebuilt, 'agent-h', 'security', 0);
    expect(counters.correct).toBe(2);
  });
});

// ── Mandatory category 2: retraction propagation ────────────────────────────

describe('retraction propagation', () => {
  it('recordConsensusRoundRetraction adds consensus_id to recent list', () => {
    const writer = new PerformanceWriter(tmpDir);
    // Seed a bucket from an UNRELATED consensus round so it survives the
    // retraction. (A bucket whose only contributing signal is in the retracted
    // round is correctly emptied by the rebuild filter.)
    writer[WRITER_INTERNAL].appendSignal(
      makeSignal('agent-i', 'agreement', { category: 'security', findingId: 'cid-other:f1' }),
    );
    writer.recordConsensusRoundRetraction('cid-retract', 'wrong reviewer');

    const data = readAggregateIndex(tmpDir)!;
    const buckets = data.agents['agent-i'].security;
    const bucket = Object.values(buckets)[0];
    expect(bucket.recentRetractedConsensusIds).toContain('cid-retract');
  });

  it('rebuild applies retractions — signals in retracted round are not counted', () => {
    // jsonl with one good signal + one in a retracted round + the tombstone
    const ts = Date.now();
    const lines = [
      JSON.stringify({
        type: 'consensus', agentId: 'agent-j', signal: 'agreement',
        category: 'security', taskId: 't1', timestamp: new Date(ts).toISOString(),
        findingId: 'cid-A:sonnet:f1', evidence: 'good',
      }),
      JSON.stringify({
        type: 'consensus', agentId: 'agent-j', signal: 'agreement',
        category: 'security', taskId: 't2', timestamp: new Date(ts + 1).toISOString(),
        findingId: 'cid-B:sonnet:f1', evidence: 'in retracted round',
      }),
      JSON.stringify({
        type: 'consensus', agentId: '_system', signal: 'consensus_round_retracted',
        consensus_id: 'cid-B', taskId: 'cid-B', timestamp: new Date(ts + 2).toISOString(),
        evidence: 'retracted',
      }),
    ];
    writeFileSync(jsonlPath, lines.join('\n') + '\n');

    const data = rebuildAggregateIndex(tmpDir);
    const counters = readCountersSince(data, 'agent-j', 'security', 0);
    // Only the cid-A signal should count
    expect(counters.correct).toBe(1);

    // The retracted consensus_id should be in every bucket's recent list
    const bucket = Object.values(data.agents['agent-j'].security)[0];
    expect(bucket.recentRetractedConsensusIds).toContain('cid-B');
  });

  it('recordRetraction in-memory caps recent list', () => {
    const data: any = { version: 1, rebuiltAt: '', lastRawTimestampMs: 0, agents: {
      a: { sec: { '0': { correct: 1, hallucinated: 0, total: 1, lastUpdateMs: 0, recentRetractedConsensusIds: [] } } },
    } };
    for (let i = 0; i < 30; i++) recordRetraction(data, 'cid-' + i);
    expect(data.agents.a.sec['0'].recentRetractedConsensusIds.length).toBeLessThanOrEqual(16);
  });
});

// ── Mandatory category 3: rotation mid-scan ─────────────────────────────────

describe('rotation mid-scan', () => {
  it('rebuild folds .jsonl.1 (rotated) and .jsonl (live) together', () => {
    const ts = Date.now();
    // Write 2 rows to .1 (rotated), 1 row to live
    writeFileSync(jsonlPath + '.1', [
      JSON.stringify({ type: 'consensus', agentId: 'agent-k', signal: 'agreement', category: 'security', taskId: 't1', timestamp: new Date(ts - 1000).toISOString(), evidence: 'x' }),
      JSON.stringify({ type: 'consensus', agentId: 'agent-k', signal: 'hallucination_caught', category: 'security', taskId: 't2', timestamp: new Date(ts - 500).toISOString(), evidence: 'x' }),
    ].join('\n') + '\n');
    writeFileSync(jsonlPath, JSON.stringify({
      type: 'consensus', agentId: 'agent-k', signal: 'agreement',
      category: 'security', taskId: 't3', timestamp: new Date(ts).toISOString(), evidence: 'x',
    }) + '\n');

    const data = rebuildAggregateIndex(tmpDir);
    const counters = readCountersSince(data, 'agent-k', 'security', 0);
    expect(counters.correct).toBe(2);
    expect(counters.hallucinated).toBe(1);
  });

  it('aggregates survive a rotation event (sidecar persists when .jsonl rotates to .1)', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-l', 'agreement', { category: 'security' }));
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-l', 'agreement', { category: 'security' }));

    // Simulate rotation: rename live → .1, then a new live arrives
    const fs = require('fs');
    fs.renameSync(jsonlPath, jsonlPath + '.1');
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-l', 'hallucination_caught', { category: 'security' }));

    // Sidecar still has 3 entries (2 from pre-rotation + 1 post)
    const data = readAggregateIndex(tmpDir)!;
    const counters = readCountersSince(data, 'agent-l', 'security', 0);
    expect(counters.correct).toBe(2);
    expect(counters.hallucinated).toBe(1);
  });
});

// ── Mandatory category 4: crash simulation ──────────────────────────────────

describe('crash simulation — jsonl appended without sidecar update', () => {
  it('sidecarIsStale detects an out-of-date sidecar', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-m', 'agreement', { category: 'security' }));

    // Simulate crash between jsonl append and sidecar fold-in by appending
    // directly + bumping mtime
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    appendFileSync(jsonlPath, JSON.stringify({
      type: 'consensus', agentId: 'agent-m', signal: 'agreement',
      category: 'security', taskId: 't-crash', timestamp: futureTs, evidence: 'x',
    }) + '\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(jsonlPath, future, future);

    const data = readAggregateIndex(tmpDir);
    expect(sidecarIsStale(tmpDir, data)).toBe(true);
  });

  it('loadOrRebuildAggregateIndex rebuilds from raw when stale', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-n', 'agreement', { category: 'security' }));

    // Crash-inject a second row + bump mtime
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    appendFileSync(jsonlPath, JSON.stringify({
      type: 'consensus', agentId: 'agent-n', signal: 'agreement',
      category: 'security', taskId: 't-crash2', timestamp: futureTs, evidence: 'x',
    }) + '\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(jsonlPath, future, future);

    const data = loadOrRebuildAggregateIndex(tmpDir);
    const counters = readCountersSince(data, 'agent-n', 'security', 0);
    expect(counters.correct).toBe(2);
  });

  it('rebuild produces deterministic counters across multiple invocations', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignals([
      makeSignal('agent-o', 'agreement', { category: 'security' }),
      makeSignal('agent-o', 'hallucination_caught', { category: 'security' }),
      makeSignal('agent-o', 'agreement', { category: 'concurrency' }),
    ]);
    const first = rebuildAggregateIndex(tmpDir);
    const second = rebuildAggregateIndex(tmpDir);
    expect(readCountersSince(first, 'agent-o', 'security', 0)).toEqual(
      readCountersSince(second, 'agent-o', 'security', 0),
    );
    expect(readCountersSince(first, 'agent-o', 'concurrency', 0)).toEqual(
      readCountersSince(second, 'agent-o', 'concurrency', 0),
    );
  });

  it('malformed sidecar JSON is treated as missing and triggers rebuild', () => {
    writeFileSync(sidecarPath, '{not valid json');
    expect(readAggregateIndex(tmpDir)).toBeNull();
    expect(sidecarIsStale(tmpDir, null)).toBe(true);
  });

  it('wrong-version sidecar is treated as missing', () => {
    writeFileSync(sidecarPath, JSON.stringify({
      version: 999, rebuiltAt: '', lastRawTimestampMs: 0, agents: {},
    }));
    expect(readAggregateIndex(tmpDir)).toBeNull();
  });
});

// ── readCountersSince filtering ─────────────────────────────────────────────

describe('readCountersSince', () => {
  it('respects sinceMs cutoff', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(
      makeSignal('agent-p', 'agreement', { category: 'security', daysAgo: 10 }),
    );
    writer[WRITER_INTERNAL].appendSignal(
      makeSignal('agent-p', 'agreement', { category: 'security', daysAgo: 1 }),
    );
    const data = readAggregateIndex(tmpDir)!;
    const cutoff = Date.now() - 5 * 86400000;
    const counters = readCountersSince(data, 'agent-p', 'security', cutoff);
    expect(counters.correct).toBe(1);
  });

  it('returns zero counters for unknown agent/category', () => {
    const data = rebuildAggregateIndex(tmpDir);
    expect(readCountersSince(data, 'ghost', 'security', 0)).toEqual({ correct: 0, hallucinated: 0 });
  });
});

// ── Fix 1: mtime-keyed reader cache ─────────────────────────────────────────

describe('reader cache (Fix 1)', () => {
  it('returns cached result on second call without re-reading disk', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-q', 'agreement', { category: 'security' }));

    const readFileSyncSpy = jest.spyOn(require('fs'), 'readFileSync');

    // First call — populates cache
    const first = readAggregateIndex(tmpDir);
    const callsAfterFirst = readFileSyncSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes(SIDECAR_FILENAME),
    ).length;

    // Second call with same mtime — should hit cache, no extra readFileSync
    const second = readAggregateIndex(tmpDir);
    const callsAfterSecond = readFileSyncSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes(SIDECAR_FILENAME),
    ).length;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(callsAfterSecond).toBe(callsAfterFirst); // no extra disk read

    readFileSyncSpy.mockRestore();
  });

  it('busts cache when mtime changes', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-r', 'agreement', { category: 'security' }));

    const first = readAggregateIndex(tmpDir);
    expect(first).not.toBeNull();
    expect(readCountersSince(first!, 'agent-r', 'security', 0).correct).toBe(1);

    // Append another signal — writer rewrites sidecar, bumping mtime
    writer[WRITER_INTERNAL].appendSignal(makeSignal('agent-r', 'agreement', { category: 'security' }));

    const second = readAggregateIndex(tmpDir);
    expect(second).not.toBeNull();
    expect(readCountersSince(second!, 'agent-r', 'security', 0).correct).toBe(2);
  });
});

// ── Fix 2: SAFE_NAME tamper validation ──────────────────────────────────────

describe('tamper validation (Fix 2)', () => {
  it('returns null for hostile agentId key (path traversal)', () => {
    writeFileSync(sidecarPath, JSON.stringify({
      version: SIDECAR_VERSION,
      rebuiltAt: new Date().toISOString(),
      lastRawTimestampMs: 0,
      agents: {
        '../../etc/passwd': { security: {} },
      },
    }));
    expect(readAggregateIndex(tmpDir)).toBeNull();
  });

  it('returns null for hostile category key (script injection)', () => {
    writeFileSync(sidecarPath, JSON.stringify({
      version: SIDECAR_VERSION,
      rebuiltAt: new Date().toISOString(),
      lastRawTimestampMs: 0,
      agents: {
        'valid-agent': { '<script>': {} },
      },
    }));
    expect(readAggregateIndex(tmpDir)).toBeNull();
  });

  it('accepts valid agentId and category keys', () => {
    const writer = new PerformanceWriter(tmpDir);
    writer[WRITER_INTERNAL].appendSignal(makeSignal('valid-agent', 'agreement', { category: 'security' }));
    const data = readAggregateIndex(tmpDir);
    expect(data).not.toBeNull();
  });
});

// ── Fix 3: Bucket growth cap ─────────────────────────────────────────────────

describe('bucket growth cap (Fix 3)', () => {
  it('caps byBound at 5 buckets, evicting the oldest', () => {
    const data: SignalAggregateIndexData = {
      version: SIDECAR_VERSION,
      rebuiltAt: new Date().toISOString(),
      lastRawTimestampMs: 0,
      agents: {},
    };

    // Fold 6 signals with distinct boundAtMs values (ascending: 100, 200, ... 600)
    for (let i = 1; i <= 6; i++) {
      foldSignal(data, 'agent-s', 'security', i * 100, 'agreement', Date.now());
    }

    const byBound = data.agents['agent-s'].security;
    const keys = Object.keys(byBound);
    expect(keys.length).toBe(5);
    // Oldest bucket (boundAtMs=100, key="100") should have been evicted
    expect(byBound['100']).toBeUndefined();
    // Newest bucket (boundAtMs=600) should be present
    expect(byBound['600']).toBeDefined();
  });

  it('numeric sort is correct — does not evict "9" before "10"', () => {
    const data: SignalAggregateIndexData = {
      version: SIDECAR_VERSION,
      rebuiltAt: new Date().toISOString(),
      lastRawTimestampMs: 0,
      agents: {},
    };

    // Simulate 5 buckets with values that would sort incorrectly under lexical ordering:
    // lexical: "10" < "200" < "9" — numeric: 9 < 10 < 200
    for (const bound of [9, 10, 200, 300, 400]) {
      foldSignal(data, 'agent-t', 'security', bound, 'agreement', Date.now());
    }
    // Now add a 6th — should evict numeric oldest (9), not lexical oldest ("10")
    foldSignal(data, 'agent-t', 'security', 500, 'agreement', Date.now());

    const byBound = data.agents['agent-t'].security;
    expect(Object.keys(byBound).length).toBe(5);
    expect(byBound['9']).toBeUndefined();  // correctly evicted (numeric oldest)
    expect(byBound['10']).toBeDefined();   // should survive
  });
});
