// tests/orchestrator/round-counter.test.ts
//
// Unit and integration-lite tests for Phase A self-telemetry: round-counter
// module (bump / get / reset / deriveConsensusId) + performanceWriter wiring.
//
// Persistence-aware: each test allocates a fresh tmpDir for `projectRoot` so
// the .gossip/round-counters.json file is isolated per test (Fix 1, spec
// 2026-04-27-self-telemetry-remediation §Fix 1).

import * as roundCounter from '../../packages/orchestrator/src/round-counter';
import { PerformanceWriter } from '@gossip/orchestrator';
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function makeTmpProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-rc-'));
  fs.mkdirSync(path.join(dir, '.gossip'), { recursive: true });
  return dir;
}

// ── Unit: bump / get / reset ──────────────────────────────────────────────────

describe('roundCounter — bump / get / reset', () => {
  const CID = 'aabbccdd-11223344';
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get returns 0 for an unknown consensusId', () => {
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('bump increments by 1 each call', () => {
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(2);
  });

  it('reset removes the entry', () => {
    roundCounter.bump(tmpDir, CID);
    roundCounter.bump(tmpDir, CID);
    roundCounter.reset(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('different consensusIds are tracked independently', () => {
    const CID2 = 'deadbeef-cafebabe';
    roundCounter.bump(tmpDir, CID);
    roundCounter.bump(tmpDir, CID);
    roundCounter.bump(tmpDir, CID2);
    expect(roundCounter.get(tmpDir, CID)).toBe(2);
    expect(roundCounter.get(tmpDir, CID2)).toBe(1);
  });

  it('different projectRoots are isolated', () => {
    const tmpDir2 = makeTmpProjectRoot();
    try {
      roundCounter.bump(tmpDir, CID);
      roundCounter.bump(tmpDir, CID);
      roundCounter.bump(tmpDir2, CID);
      expect(roundCounter.get(tmpDir, CID)).toBe(2);
      expect(roundCounter.get(tmpDir2, CID)).toBe(1);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe('roundCounter — persistence (Fix 1)', () => {
  const CID = 'cafebabe-feedf00d';
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists across a simulated process restart', () => {
    roundCounter.bump(tmpDir, CID);
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(2);

    // Simulate restart: clear in-memory fallback. The persisted file must
    // still contain the count, so a fresh `get()` returns 2.
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(2);

    // Subsequent bump increments from the persisted value, not from 0.
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(3);
  });

  it('writes a parseable JSON file with _version: 1', () => {
    roundCounter.bump(tmpDir, CID);
    const file = path.join(tmpDir, '.gossip', 'round-counters.json');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed._version).toBe(1);
    expect(parsed.counts[CID]).toBe(1);
  });

  it('atomic write: file always parseable across many bumps', () => {
    // Sequential bumps from a single process — exercise the temp+rename path
    // and confirm the visible file never lands in a half-written state.
    for (let i = 0; i < 25; i++) roundCounter.bump(tmpDir, CID);
    const file = path.join(tmpDir, '.gossip', 'round-counters.json');
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
    expect(roundCounter.get(tmpDir, CID)).toBe(25);
  });

  it('corrupt JSON file: bump still succeeds and overwrites', () => {
    const file = path.join(tmpDir, '.gossip', 'round-counters.json');
    fs.writeFileSync(file, '{not valid json');
    expect(() => roundCounter.bump(tmpDir, CID)).not.toThrow();
    // After bump the file is canonical again.
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed._version).toBe(1);
    expect(parsed.counts[CID]).toBe(1);
  });

  it('schema mismatch: future _version treated as empty + warns once', () => {
    const file = path.join(tmpDir, '.gossip', 'round-counters.json');
    fs.writeFileSync(file, JSON.stringify({ _version: 999, counts: { [CID]: 42 } }));

    const writes: string[] = [];
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: any) => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });

    try {
      roundCounter.bump(tmpDir, CID);
      // Stale value ignored — bump starts from 0 + 1 = 1.
      expect(roundCounter.get(tmpDir, CID)).toBe(1);

      // First read after the bump's own RMW should NOT re-warn (the bump
      // already overwrote the file with _version: 1). Force another mismatch
      // and confirm the latch suppresses re-logging.
      fs.writeFileSync(file, JSON.stringify({ _version: 999, counts: {} }));
      roundCounter.bump(tmpDir, CID);

      const schemaWarnings = writes.filter(w => w.includes('schema version'));
      expect(schemaWarnings.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('read-only filesystem: bump does not throw and stays in-memory', () => {
    const dir = path.join(tmpDir, '.gossip');
    // chmod the .gossip directory to read-only. writeFileSync under it will fail.
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => roundCounter.bump(tmpDir, CID)).not.toThrow();
      // In-memory fallback returns the bump within this process even though
      // the file write failed.
      expect(roundCounter.get(tmpDir, CID)).toBe(1);
    } finally {
      // Restore so afterEach cleanup can rm the dir.
      fs.chmodSync(dir, 0o755);
    }
  });

  it('missing file is treated as empty (no throw)', () => {
    // No file ever written — bump should create it.
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
  });

  it('empty file is treated as empty (no throw)', () => {
    const file = path.join(tmpDir, '.gossip', 'round-counters.json');
    fs.writeFileSync(file, '');
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
  });
});

// ── Unit: deriveConsensusId ───────────────────────────────────────────────────

describe('roundCounter — deriveConsensusId', () => {
  it('returns consensusId when present', () => {
    expect(roundCounter.deriveConsensusId({ consensusId: 'aabbccdd-11223344' }))
      .toBe('aabbccdd-11223344');
  });

  it('extracts consensusId from modern findingId (with consensusId absent)', () => {
    expect(roundCounter.deriveConsensusId({ findingId: 'aabbccdd-11223344:sonnet-reviewer:f1' }))
      .toBe('aabbccdd-11223344');
  });

  it('extracts consensusId from legacy findingId (two-segment)', () => {
    expect(roundCounter.deriveConsensusId({ findingId: 'aabbccdd-11223344:f3' }))
      .toBe('aabbccdd-11223344');
  });

  it('returns undefined when neither field is present', () => {
    expect(roundCounter.deriveConsensusId({})).toBeUndefined();
  });

  it('returns undefined for malformed findingId (free-form string)', () => {
    expect(roundCounter.deriveConsensusId({ findingId: 'not-a-real-id:f1' })).toBeUndefined();
  });

  it('returns undefined for findingId with no colon (bare string)', () => {
    expect(roundCounter.deriveConsensusId({ findingId: 'barestring' })).toBeUndefined();
  });

  it('prefers consensusId over findingId when both are present', () => {
    expect(
      roundCounter.deriveConsensusId({
        consensusId: 'aabbccdd-11223344',
        findingId: 'deadbeef-cafebabe:f1',
      })
    ).toBe('aabbccdd-11223344');
  });
});

// ── Integration-lite: performanceWriter bumps counter on append ───────────────

describe('PerformanceWriter — round counter wiring', () => {
  let tmpDir: string;
  let writer: PerformanceWriter;
  const CID = 'cafef00d-beefdead';

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    writer = new PerformanceWriter(tmpDir);
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeSignal = (consensusId: string) => ({
    type: 'consensus' as const,
    taskId: `task-${consensusId}`,
    signal: 'agreement' as const,
    agentId: 'test-agent',
    consensusId,
    evidence: 'test',
    timestamp: new Date().toISOString(),
  });

  it('bumps counter once per appendSignal with consensusId', () => {
    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    expect(roundCounter.get(tmpDir, CID)).toBe(2);
  });

  it('bumps counter for each signal in appendSignals', () => {
    const signals = [makeSignal(CID), makeSignal(CID), makeSignal(CID)];
    writer[WRITER_INTERNAL].appendSignals(signals);
    expect(roundCounter.get(tmpDir, CID)).toBe(3);
  });

  it('does NOT bump counter for signals without consensusId or findingId', () => {
    const metaSignal = {
      type: 'meta' as const,
      signal: 'task_completed' as const,
      agentId: 'test-agent',
      taskId: 'task-123',
      timestamp: new Date().toISOString(),
    };
    writer[WRITER_INTERNAL].appendSignal(metaSignal);
    // Counter for CID stays at 0 — meta signals have no consensusId
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('shortfall detection: writing N signals → counter == N, dropping one → shortfall', () => {
    // Simulate writing 3 signals for a round with 4 findings
    const N = 3;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    const actual = roundCounter.get(tmpDir, CID);
    const findings_count = 4;
    expect(actual).toBe(N);
    expect(actual).toBeLessThan(findings_count); // shortfall detected
    expect(findings_count - actual).toBe(1); // one signal dropped
  });

  it('bumps counter for signal with findingId prefix (no consensusId field)', () => {
    const signalWithFindingId = {
      type: 'consensus' as const,
      taskId: 'task-bulk',
      signal: 'unique_confirmed' as const,
      agentId: 'test-agent',
      // no consensusId — only findingId carrying the prefix
      findingId: `${CID}:test-agent:f1`,
      evidence: 'test',
      timestamp: new Date().toISOString(),
    };
    writer[WRITER_INTERNAL].appendSignal(signalWithFindingId);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
  });

  it('reset after signal_loss_suspected emit leaves counter at 0', () => {
    const N = 3;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(N);

    // Mimic the self-bump that emitPipelineSignals causes when it writes the
    // signal_loss_suspected diagnostic (pipeline signal carries consensusId).
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(N + 1);

    // resetRoundCounter is called on collect-end (Cosmetic A — both happy and
    // shortfall paths).
    roundCounter.reset(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('Fix 2 — recordConsensusRoundRetraction resets the round counter', () => {
    // Emit signals so the counter is non-zero.
    const N = 4;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(N);

    // Retract the round — counter must drop to 0 (not just decremented),
    // mirroring the spec invariant that the round is "dead, drop accumulated
    // signals."
    writer.recordConsensusRoundRetraction(CID, 'test retraction');
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('f1 — tombstone write failure does not skip reset (counter ends at 0)', () => {
    // Emit signals so the counter is non-zero.
    const N = 3;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(N);

    // Make the JSONL file read-only so appendFileSync throws.
    const jsonlPath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    // Ensure the file exists before chmoding.
    if (!fs.existsSync(jsonlPath)) {
      fs.writeFileSync(jsonlPath, '');
    }
    fs.chmodSync(jsonlPath, 0o444);

    try {
      // recordConsensusRoundRetraction may throw because appendFileSync fails,
      // but via try/finally the reset MUST still fire — counter ends at 0.
      try {
        writer.recordConsensusRoundRetraction(CID, 'test retraction with write failure');
      } catch {
        // tombstone write failed as expected — ignore the error
      }
      // Counter must be 0 regardless of whether the tombstone write succeeded.
      expect(roundCounter.get(tmpDir, CID)).toBe(0);
    } finally {
      fs.chmodSync(jsonlPath, 0o644);
    }
  });
});

// ── Fix 2 follow-up: reset() on read-only filesystem ─────────────────────────

describe('roundCounter — reset() on read-only filesystem (f2)', () => {
  const CID = 'f2f2f2f2-deadc0de';
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
    // Restore write permissions before cleanup to allow rmSync to succeed.
    const gossipDir = path.join(tmpDir, '.gossip');
    try { fs.chmodSync(gossipDir, 0o755); } catch { /* ignore if already removed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get() returns 0 after reset() even when filesystem is read-only', () => {
    // Bump once to persist a non-zero count.
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);

    // Make .gossip/ read-only so writeCountersAtomic fails on reset.
    const gossipDir = path.join(tmpDir, '.gossip');
    fs.chmodSync(gossipDir, 0o555);

    try {
      // reset() must not throw, and get() must return 0 even though the
      // persisted file still has count=1 (read-only fs prevented the write).
      expect(() => roundCounter.reset(tmpDir, CID)).not.toThrow();
      expect(roundCounter.get(tmpDir, CID)).toBe(0);
    } finally {
      fs.chmodSync(gossipDir, 0o755);
    }
  });
});

// ── Known limitation: concurrent bump RMW ─────────────────────────────────────

describe('roundCounter — concurrent bump (f5 known limitation)', () => {
  const CID = 'c0c0c0c0-f5f5f5f5';
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('concurrent bumps from same projectRoot leave file parseable (known RMW race)', async () => {
    // 10 concurrent bumps on the same CID from a single process.
    // KNOWN LIMITATION: last-writer-wins RMW means some bumps may be lost,
    // but the file must ALWAYS remain valid JSON (no truncation/corruption).
    const CONCURRENCY = 10;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => Promise.resolve(roundCounter.bump(tmpDir, CID))),
    );

    const file = path.join(tmpDir, '.gossip', 'round-counters.json');
    // File must be parseable.
    let parsed: any;
    expect(() => { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }).not.toThrow();
    expect(parsed._version).toBe(1);

    // Counter must be at least 1 and at most CONCURRENCY.
    // (Single-process sequential JS means all 10 should land; this guard
    // documents the RMW semantics rather than asserting an exact value.)
    const count = roundCounter.get(tmpDir, CID);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(CONCURRENCY);
  });
});

// ── Fix 4: signal-class filter at the round-counter bump site ─────────────────
//
// Addresses haiku-researcher:f8 (consensus f21444f3-a6294a51): operational
// signals that carry a derivable consensusId (e.g. task_timeout emitted during
// a relay cross-review) must not inflate the shortfall comparison.

describe('PerformanceWriter — Fix 4: operational signals do not bump counter', () => {
  let tmpDir: string;
  let writer: PerformanceWriter;
  const CID = 'f4f4f4f4-deadc0de';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-fix4-'));
    fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
    writer = new PerformanceWriter(tmpDir);
    roundCounter.reset(CID);
  });

  afterEach(() => {
    roundCounter.reset(CID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makePerformanceSignal = (consensusId: string) => ({
    type: 'consensus' as const,
    signal: 'unique_confirmed' as const,
    agentId: 'test-agent',
    taskId: `task-${consensusId}`,
    consensusId,
    evidence: 'test',
    timestamp: new Date().toISOString(),
  });

  const makeOperationalSignal = (consensusId: string) => ({
    type: 'consensus' as const,
    signal: 'task_timeout' as const,
    agentId: 'test-agent',
    taskId: `task-${consensusId}`,
    consensusId,
    evidence: 'timeout diagnostic',
    timestamp: new Date().toISOString(),
  });

  it('Fix 4 — performance signals bump counter normally (appendSignal)', () => {
    writer[WRITER_INTERNAL].appendSignal(makePerformanceSignal(CID));
    expect(roundCounter.get(CID)).toBe(1);
  });

  it('Fix 4 — operational signals do NOT bump counter (appendSignal)', () => {
    // task_timeout is classified as 'operational' by classifySignal.
    // Even when it carries a derivable consensusId it must not count.
    writer[WRITER_INTERNAL].appendSignal(makeOperationalSignal(CID));
    expect(roundCounter.get(CID)).toBe(0);
  });

  it('Fix 4 — mixed batch: only performance signals bump (appendSignals)', () => {
    // [performance, operational, performance] → counter = 2, not 3.
    const batch = [
      makePerformanceSignal(CID),
      makeOperationalSignal(CID),
      makePerformanceSignal(CID),
    ];
    writer[WRITER_INTERNAL].appendSignals(batch);
    expect(roundCounter.get(CID)).toBe(2);
  });

  it('Fix 4 — unknown signal name (classifySignal returns undefined) still bumps (backwards compat)', () => {
    // A signal whose name is not in PERFORMANCE_SIGNAL_NAMES or
    // OPERATIONAL_SIGNAL_NAMES causes classifySignal to return undefined.
    // The filter treats undefined as performance-equivalent so pre-existing
    // signals are not silently dropped from the counter.
    const unknownSignal = {
      type: 'consensus' as const,
      // Bypass VALID_CONSENSUS_SIGNALS by using a known-valid signal name but
      // simulate the classifySignal(undefined) path by using 'severity_miscalibrated'
      // which is in VALID_CONSENSUS_SIGNALS but NOT in either classify set.
      signal: 'severity_miscalibrated' as any,
      agentId: 'test-agent',
      taskId: `task-${CID}`,
      consensusId: CID,
      evidence: 'test',
      timestamp: new Date().toISOString(),
    };
    writer[WRITER_INTERNAL].appendSignal(unknownSignal);
    // classifySignal('severity_miscalibrated') returns undefined → preserved as
    // performance-equivalent → counter bumps.
    expect(roundCounter.get(CID)).toBe(1);
  });
});
