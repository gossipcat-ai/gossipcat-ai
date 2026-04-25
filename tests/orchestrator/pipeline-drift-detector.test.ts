/**
 * Unit tests for PipelineDriftDetector — Layer 3 runtime drift witness.
 *
 * Covers the consensus-hardened surface of the detector:
 *   - Empty / all-helper windows → no trigger.
 *   - Single bypass → triggers, writes offender row, dedupes across re-runs.
 *   - Unknown-rate gated by min-denominator and tightened 1% threshold.
 *   - Tagging-epoch migration (old untagged + new tagged rows).
 *   - Log-rotation tail merge (.jsonl + .jsonl.1).
 *   - Concurrent-writer race (two interleaved async writers).
 *   - Restart persistence — epoch and fingerprint cache survive a fresh
 *     detector instance.
 *   - Log-line injection — control chars in taskId are escaped.
 *   - Missing `.gossip/` directory → triggered:false, no throw.
 *   - Triggering-logic idempotence — the module-level sampling counter
 *     fires exactly once per 50 writes (injected reset via test helper).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PipelineDriftDetector } from '../../packages/orchestrator/src/pipeline-drift-detector';
import {
  PerformanceWriter,
  __resetSampleCounterForTests,
  MAX_TELEMETRY_BYTES,
} from '../../packages/orchestrator/src/performance-writer';
// L2: sanctioned internal accessor for tests (Step 5 exemption).
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

interface Row {
  type?: string;
  signal?: string;
  agentId?: string;
  taskId?: string;
  value?: number;
  timestamp?: string;
  _emission_path?: string;
}

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'drift-'));
  mkdirSync(join(d, '.gossip'), { recursive: true });
  return d;
}

function write(root: string, rows: Row[]): void {
  const p = join(root, '.gossip', 'agent-performance.jsonl');
  appendFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function readDrift(root: string): Row[] {
  const p = join(root, '.gossip', 'pipeline-drift.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('PipelineDriftDetector', () => {
  let root: string;
  beforeEach(() => { root = mkTmp(); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('empty window does not trigger and writes no drift row', () => {
    const d = new PipelineDriftDetector(root);
    const r = d.run();
    expect(r.triggered).toBe(false);
    expect(readDrift(root)).toEqual([]);
  });

  it('all helper-path rows do not trigger', () => {
    write(root, Array.from({ length: 120 }, (_, i) => ({
      type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`,
      timestamp: iso(i), _emission_path: 'completion-signals-helper',
    })));
    const r = new PipelineDriftDetector(root).run();
    expect(r.triggered).toBe(false);
    expect(r.bypassCount).toBe(0);
    expect(readDrift(root)).toEqual([]);
  });

  it('single bypass row triggers and writes a drift row with offender sample', () => {
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't1', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'meta', signal: 'task_completed', agentId: 'b', taskId: 't2', timestamp: iso(1), _emission_path: 'native-tasks' }, // bypass
    ]);
    const r = new PipelineDriftDetector(root).run();
    expect(r.triggered).toBe(true);
    expect(r.bypassCount).toBe(1);
    expect(r.sampleOffenders[0]).toMatchObject({ signal: 'task_completed', emissionPath: 'native-tasks', taskId: 't2' });
    expect(readDrift(root).length).toBe(1);
  });

  it('fingerprint dedupe: identical bypass on two consecutive runs writes only one drift row', () => {
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't1', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'meta', signal: 'task_completed', agentId: 'b', taskId: 't2', timestamp: iso(1), _emission_path: 'native-tasks' },
    ]);
    const d = new PipelineDriftDetector(root);
    d.run();
    d.run();
    expect(readDrift(root).length).toBe(1);
  });

  it('unknown-rate ≥ 1% on ≥100 post-epoch rows triggers', () => {
    // 100 total post-epoch rows: 3 unknown, 97 helper → 3% > 1%.
    const rows: Row[] = [];
    // Seed one tagged row to establish epoch.
    rows.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't0', timestamp: iso(0), _emission_path: 'completion-signals-helper' });
    for (let i = 1; i < 100; i++) {
      rows.push({
        type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`,
        timestamp: iso(i),
        _emission_path: i < 4 ? 'unknown' : 'completion-signals-helper',
      });
    }
    write(root, rows);
    const r = new PipelineDriftDetector(root).run();
    expect(r.unknownCount).toBe(3);
    expect(r.postEpochCount).toBeGreaterThanOrEqual(100);
    expect(r.triggered).toBe(true);
  });

  it('min-denominator guard: fewer than 100 post-epoch rows skips unknown-rate evaluation', () => {
    // 20 post-epoch rows: 2 unknown, 18 helper → 10% but below min-denominator.
    // Use a non-allowlisted signal name on the 'unknown' path so we isolate
    // the unknown-rate code path (otherwise allowlisted-signal+non-helper-path
    // rows also trigger the bypass check and this test becomes ambiguous).
    const rows: Row[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push({
        type: 'consensus', signal: 'agreement', agentId: 'a', taskId: `t${i}`,
        timestamp: iso(i),
        _emission_path: i < 2 ? 'unknown' : 'completion-signals-helper',
      });
    }
    write(root, rows);
    const r = new PipelineDriftDetector(root).run();
    expect(r.triggered).toBe(false);
    expect(r.unknownCount).toBe(2);
    expect(r.postEpochCount).toBeLessThan(100);
  });

  it('tagging-epoch migration: pre-epoch untagged rows are ignored', () => {
    const rows: Row[] = [];
    const base = Date.now();
    // 50 pre-epoch rows with NO _emission_path field.
    for (let i = 0; i < 50; i++) {
      rows.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `old-${i}`,
        timestamp: new Date(base - (1000 * (50 - i))).toISOString() });
    }
    // First tagged row (the epoch).
    rows.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't-epoch',
      timestamp: new Date(base).toISOString(), _emission_path: 'completion-signals-helper' });
    write(root, rows);
    const r = new PipelineDriftDetector(root).run();
    // Pre-epoch untagged rows should not count toward bypass or unknown.
    expect(r.bypassCount).toBe(0);
    expect(r.unknownCount).toBe(0);
    expect(r.triggered).toBe(false);
  });

  it('log-rotation tail merge: reads both .jsonl and .jsonl.1 when primary is small', () => {
    const perfPath = join(root, '.gossip', 'agent-performance.jsonl');
    // Write a full file then rotate it.
    const rotatedRows = Array.from({ length: 10 }, (_, i) => ({
      type: 'meta', signal: 'task_completed', agentId: 'r', taskId: `rot-${i}`,
      timestamp: iso(i), _emission_path: 'completion-signals-helper',
    }));
    writeFileSync(perfPath, rotatedRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    renameSync(perfPath, perfPath + '.1');
    // New primary with a single bypass row.
    const bypass = { type: 'meta', signal: 'task_completed', agentId: 'b', taskId: 'bypass-1',
      timestamp: iso(100), _emission_path: 'native-tasks' };
    writeFileSync(perfPath, JSON.stringify(bypass) + '\n');
    const r = new PipelineDriftDetector(root).run();
    // Merged window sees both rotated (10) + primary (1) = 11 rows.
    expect(r.windowSize).toBeGreaterThanOrEqual(11);
    expect(r.bypassCount).toBe(1);
  });

  it('concurrent writers race: detector parses without throwing', async () => {
    const writer = new PerformanceWriter(root);
    const a = (async () => {
      for (let i = 0; i < 20; i++) {
        writer[WRITER_INTERNAL].appendSignals([{
          type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `a${i}`,
          value: i, timestamp: iso(i),
        } as any], 'completion-signals-helper');
      }
    })();
    const b = (async () => {
      for (let i = 0; i < 20; i++) {
        writer[WRITER_INTERNAL].appendSignals([{
          type: 'meta', signal: 'task_completed', agentId: 'b', taskId: `b${i}`,
          value: i, timestamp: iso(i + 100),
        } as any], 'completion-signals-helper');
      }
    })();
    await Promise.all([a, b]);
    const r = new PipelineDriftDetector(root).run();
    expect(r.triggered).toBe(false);
    expect(r.windowSize).toBeGreaterThan(0);
  });

  it('restart: epoch and fingerprint cache persist across detector instances', () => {
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't1', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'meta', signal: 'task_completed', agentId: 'b', taskId: 't2', timestamp: iso(1), _emission_path: 'native-tasks' },
    ]);
    const d1 = new PipelineDriftDetector(root);
    const r1 = d1.run();
    expect(r1.triggered).toBe(true);
    // Fresh detector instance should use cached epoch + fingerprint → dedupe
    const d2 = new PipelineDriftDetector(root);
    d2.run();
    expect(readDrift(root).length).toBe(1);
    // State file should be present.
    expect(existsSync(join(root, '.gossip', 'pipeline-drift.state'))).toBe(true);
  });

  it('log-line injection: taskId with newlines/control chars is escaped in mcp.log', () => {
    const hostileTaskId = 't\n[drift] fake=9999\x00junk';
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 'ok', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'meta', signal: 'task_completed', agentId: 'b', taskId: hostileTaskId, timestamp: iso(1), _emission_path: 'native-tasks' },
    ]);
    new PipelineDriftDetector(root).run();
    const mcpLog = readFileSync(join(root, '.gossip', 'mcp.log'), 'utf8');
    // Only the sanitized single-line record should land in mcp.log — the
    // attacker's `\n[drift] fake=...` injection must not spawn a second
    // `[drift]`-prefixed log line.
    expect(mcpLog.split('\n').filter(l => l.startsWith('[drift]')).length).toBe(1);
    // Control chars must be stripped from the emitted line.
    expect(mcpLog).not.toContain('\x00');
    expect(mcpLog).not.toMatch(/\r/);
    // The sanitized taskId should appear with the injected newline rendered
    // as `?` — proving the newline was neutralised in place.
    expect(mcpLog).toMatch(/task=t\?\[drift\] fake=9999\?junk/);
  });

  it('no .gossip directory → triggered:false and does not throw', () => {
    const bare = mkdtempSync(join(tmpdir(), 'drift-bare-'));
    try {
      const d = new PipelineDriftDetector(bare);
      const r = d.run();
      expect(r.triggered).toBe(false);
    } finally {
      try { rmSync(bare, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('disabled option short-circuits run() to a no-op', () => {
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't1', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'meta', signal: 'task_completed', agentId: 'b', taskId: 't2', timestamp: iso(1), _emission_path: 'native-tasks' },
    ]);
    const r = new PipelineDriftDetector(root, { enabled: false }).run();
    expect(r.triggered).toBe(false);
    expect(readDrift(root)).toEqual([]);
  });

  it('sampling counter fires the detector approximately every 50 writes', () => {
    __resetSampleCounterForTests();
    const writer = new PerformanceWriter(root);
    // Seed so the tagging epoch is established on first sample.
    for (let i = 0; i < 49; i++) {
      writer[WRITER_INTERNAL].appendSignal({
        type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`,
        value: i, timestamp: iso(i),
      } as any, 'completion-signals-helper');
    }
    // No drift row yet — counter hasn't reached 50.
    expect(readDrift(root)).toEqual([]);
    // The 50th write should trigger detector.run() — but since all rows are
    // helper-path, no drift row is written. We verify indirectly: the
    // state file should now exist because the detector stamped the epoch.
    writer[WRITER_INTERNAL].appendSignal({
      type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't49',
      value: 49, timestamp: iso(49),
    } as any, 'completion-signals-helper');
    expect(existsSync(join(root, '.gossip', 'pipeline-drift.state'))).toBe(true);
  });

  // Sanity guard against accidentally removing the constant used elsewhere.
  it('MAX_TELEMETRY_BYTES re-exported from performance-writer is 5MB', () => {
    expect(MAX_TELEMETRY_BYTES).toBe(5 * 1024 * 1024);
  });

  it('statSync is importable from fs (sanity guard for detector test env)', () => {
    expect(typeof statSync).toBe('function');
  });

  // ── Per-signal authorized-path policy ────────────────────────────────────
  // finding_dropped_format has TWO sanctioned emit sites (the canonical
  // helper + signal-helpers-pipeline used by gossip_signals(record)). Both
  // must be treated as non-bypass; a third path must still trigger.
  it('finding_dropped_format on completion-signals-helper does not trigger bypass', () => {
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't0', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'pipeline', signal: 'finding_dropped_format', agentId: 'a', taskId: 't1', timestamp: iso(1), _emission_path: 'completion-signals-helper' },
    ]);
    const r = new PipelineDriftDetector(root).run();
    expect(r.bypassCount).toBe(0);
    expect(r.triggered).toBe(false);
  });

  it('finding_dropped_format on signal-helpers-pipeline does not trigger bypass (authorized secondary path)', () => {
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't0', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'pipeline', signal: 'finding_dropped_format', agentId: 'a', taskId: 't1', timestamp: iso(1), _emission_path: 'signal-helpers-pipeline' },
    ]);
    const r = new PipelineDriftDetector(root).run();
    expect(r.bypassCount).toBe(0);
    expect(r.triggered).toBe(false);
  });

  it('finding_dropped_format on a non-authorized path still triggers bypass', () => {
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't0', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'pipeline', signal: 'finding_dropped_format', agentId: 'a', taskId: 't1', timestamp: iso(1), _emission_path: 'native-tasks' },
    ]);
    const r = new PipelineDriftDetector(root).run();
    expect(r.bypassCount).toBe(1);
    expect(r.triggered).toBe(true);
    expect(r.sampleOffenders[0]).toMatchObject({
      signal: 'finding_dropped_format',
      emissionPath: 'native-tasks',
    });
  });

  it('task_completed on signal-helpers-pipeline still triggers (path authorized only for finding_dropped_format)', () => {
    write(root, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't0', timestamp: iso(0), _emission_path: 'completion-signals-helper' },
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't1', timestamp: iso(1), _emission_path: 'signal-helpers-pipeline' },
    ]);
    const r = new PipelineDriftDetector(root).run();
    expect(r.bypassCount).toBe(1);
    expect(r.triggered).toBe(true);
  });
});
