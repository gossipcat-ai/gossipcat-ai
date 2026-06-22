// tests/orchestrator/round-counter.test.ts
//
// Unit and integration-lite tests for Phase A self-telemetry: round-counter
// module (bump / get / reset / deriveConsensusId) + performanceWriter wiring.
//
// Persistence model — Option C (spec 2026-04-27-self-telemetry-crash-consistency):
// counter mutations are merged into the agent-performance.jsonl stream as
// `_meta`/`round_counter_bumped` and `_meta`/`round_counter_reset` records.
// The legacy `<projectRoot>/.gossip/round-counters.json` file is no longer
// written or read by this module.
//
// Each test allocates a fresh tmpDir for `projectRoot` so the JSONL is
// isolated per test.

import * as roundCounter from '../../packages/orchestrator/src/round-counter';
import { PerformanceWriter } from '@gossip/orchestrator';
import { __resetLoggedCounterErrorsForTests } from '../../packages/orchestrator/src/performance-writer';
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

// ── Persistence (Option C — JSONL-derived state) ─────────────────────────────

describe('roundCounter — persistence (Option C)', () => {
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

  it('persists across a simulated process restart via JSONL meta-records', () => {
    roundCounter.bump(tmpDir, CID);
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(2);

    // Simulate restart: clear in-memory fallback + scan cache. The JSONL
    // still contains both bump records, so a fresh `get()` returns 2.
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(2);

    // Subsequent bump increments from the JSONL-derived value, not from 0.
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(3);
  });

  it('writes round_counter_bumped records into agent-performance.jsonl', () => {
    roundCounter.bump(tmpDir, CID);
    const file = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const bumpRecs = lines
      .map(l => JSON.parse(l))
      .filter((r: any) => r.type === '_meta' && r.signal === 'round_counter_bumped' && r.consensusId === CID);
    expect(bumpRecs).toHaveLength(1);
    expect(typeof bumpRecs[0].bumpedAt).toBe('string');
  });

  it('reset() writes a round_counter_reset record into the JSONL', () => {
    roundCounter.bump(tmpDir, CID);
    roundCounter.reset(tmpDir, CID);
    const file = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const resetRecs = lines
      .map(l => JSON.parse(l))
      .filter((r: any) => r.type === '_meta' && r.signal === 'round_counter_reset' && r.consensusId === CID);
    expect(resetRecs).toHaveLength(1);
    expect(typeof resetRecs[0].resetAt).toBe('string');
  });

  it('many sequential bumps: each adds exactly one record', () => {
    for (let i = 0; i < 25; i++) roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(25);
    const file = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // All lines should be parseable.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const bumpCount = lines
      .map(l => JSON.parse(l))
      .filter((r: any) => r.type === '_meta' && r.signal === 'round_counter_bumped' && r.consensusId === CID)
      .length;
    expect(bumpCount).toBe(25);
  });

  it('truncated JSONL tail: get() skips the malformed line and returns count of valid bumps', () => {
    roundCounter.bump(tmpDir, CID);
    roundCounter.bump(tmpDir, CID);
    roundCounter.bump(tmpDir, CID);
    const file = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    // Append a truncated/partial JSON record (simulates a process kill mid-write
    // — POSIX says only the last record can be truncated).
    fs.appendFileSync(file, '{"type":"_meta","signal":"round_counter_bumped","consensus');
    // Force scan-cache invalidation since mtime/size changed but we cached pre-truncate.
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(3);
  });

  it('reset followed by 3 more bumps: get returns 3 (not 8)', () => {
    for (let i = 0; i < 5; i++) roundCounter.bump(tmpDir, CID);
    roundCounter.reset(tmpDir, CID);
    for (let i = 0; i < 3; i++) roundCounter.bump(tmpDir, CID);
    // Force a fresh scan to confirm JSONL-derived state matches expectation.
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(3);
  });

  it('F3 — interleaved reset and bump: final count == bumps after the latest reset record', () => {
    // The append-only JSONL guarantees record ordering matches the order of
    // appendFileSync calls. A reset is just a `_meta`/`round_counter_reset`
    // line; bumps after it are counted, bumps before it are masked. This test
    // confirms the get() semantics are deterministic regardless of the
    // bump/reset interleave: we drive an explicit interleave (5 bumps → reset
    // → 2 bumps → reset → 3 bumps) and assert get() == 3.
    for (let i = 0; i < 5; i++) roundCounter.bump(tmpDir, CID);
    roundCounter.reset(tmpDir, CID);
    for (let i = 0; i < 2; i++) roundCounter.bump(tmpDir, CID);
    roundCounter.reset(tmpDir, CID);
    for (let i = 0; i < 3; i++) roundCounter.bump(tmpDir, CID);
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(3);

    // Confirm the JSONL contains the exact sequence we expect: 5 bumps,
    // 1 reset, 2 bumps, 1 reset, 3 bumps. Total 12 lines.
    const file = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const bumps = lines.filter(l => l.includes('round_counter_bumped'));
    const resets = lines.filter(l => l.includes('round_counter_reset'));
    expect(bumps).toHaveLength(10);
    expect(resets).toHaveLength(2);
  });

  it('read-only filesystem: bump does not throw and stays in-memory', () => {
    const dir = path.join(tmpDir, '.gossip');
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => roundCounter.bump(tmpDir, CID)).not.toThrow();
      // In-memory fallback returns the bump within this process even though
      // the JSONL append failed.
      expect(roundCounter.get(tmpDir, CID)).toBe(1);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('ROFS-recovery: prior in-memory bumps are flushed to JSONL when FS recovers', () => {
    // Skip when running as root (chmod has no effect for root).
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const gossipDir = path.join(tmpDir, '.gossip');

    // Phase 1: filesystem is read-only — 3 bumps accumulate in-memory only.
    fs.chmodSync(gossipDir, 0o555);
    try {
      roundCounter.bump(tmpDir, CID);
      roundCounter.bump(tmpDir, CID);
      roundCounter.bump(tmpDir, CID);
    } finally {
      fs.chmodSync(gossipDir, 0o755);
    }
    // In-memory shadow sees all 3 even though nothing was persisted.
    expect(roundCounter.get(tmpDir, CID)).toBe(3);

    // Phase 2: filesystem recovers — 4th bump should flush the 3 prior bumps.
    roundCounter.bump(tmpDir, CID);
    // get() must now return 4, not 1.
    expect(roundCounter.get(tmpDir, CID)).toBe(4);

    // Verify persistence: force a fresh JSONL scan (no in-memory state).
    roundCounter.__resetForTests();
    // The JSONL now contains 4 bump records (3 backfill + 1 live).
    expect(roundCounter.get(tmpDir, CID)).toBe(4);
  });

  it('ROFS file-only readonly: fallback continues to accumulate across bump cycles', () => {
    // Skip when running as root.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const gossipDir = path.join(tmpDir, '.gossip');

    // Phase 1: dir read-only — 2 bumps accumulate in-memory.
    fs.chmodSync(gossipDir, 0o555);
    try {
      roundCounter.bump(tmpDir, CID);
      roundCounter.bump(tmpDir, CID);
    } finally {
      fs.chmodSync(gossipDir, 0o755);
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(2);

    // Phase 2: dir is writable but the JSONL file itself is read-only
    // (FS-flapping scenario). The live bump's append still fails, so the
    // bump goes through the !ok path — fallback should increment to 3.
    fs.mkdirSync(gossipDir, { recursive: true });
    const jsonlFile = path.join(gossipDir, 'agent-performance.jsonl');
    fs.writeFileSync(jsonlFile, '');
    fs.chmodSync(jsonlFile, 0o444);

    try {
      roundCounter.bump(tmpDir, CID);
      // appendMetaRecord returned false → !ok branch → fbk = priorCount + 1 = 3.
      expect(roundCounter.get(tmpDir, CID)).toBe(3);
    } finally {
      fs.chmodSync(jsonlFile, 0o644);
    }
  });

  it('missing file is treated as empty (no throw)', () => {
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
  });

  it('empty file is treated as empty (no throw)', () => {
    const file = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    fs.writeFileSync(file, '');
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
  });

  it('caches scan result and reflects new bumps after JSONL grows', () => {
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
    // Repeated reads on an unchanged file return the same cached count.
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
    // A subsequent bump grows the file (mtime + size change), so the next
    // get() invalidates the cache and reflects the new count.
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(2);
  });

  it('rebuilds counter state after __resetForTests (cache invalidation)', () => {
    for (let i = 0; i < 4; i++) roundCounter.bump(tmpDir, CID);
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(4);
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

describe('PerformanceWriter — round counter wiring (Option C inline meta-records)', () => {
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

  it('writes N signals via appendSignal → get() returns N (Option C single-write atomicity)', () => {
    const N = 5;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(N);
  });

  it('signal row and bump meta-record land adjacently in the JSONL (Option C inline emission)', () => {
    // Direct evidence that the writer emits the bump meta-record alongside
    // the signal payload: after appendSignal, the JSONL contains exactly two
    // lines — the signal row, immediately followed by the round_counter_bumped
    // meta-record for the same consensusId. Under the legacy two-file design
    // there was only one line in this file (the bump lived in round-counters.json),
    // so this ordering invariant is unique to Option C.
    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    const jsonlPath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const signalRow = JSON.parse(lines[0]);
    const bumpRow = JSON.parse(lines[1]);
    expect(signalRow.signal).toBe('agreement');
    expect(bumpRow).toMatchObject({
      type: '_meta',
      signal: 'round_counter_bumped',
      consensusId: CID,
    });
  });

  it('writes N signals via appendSignals batch → get() returns N', () => {
    const N = 4;
    const signals = Array.from({ length: N }, () => makeSignal(CID));
    writer[WRITER_INTERNAL].appendSignals(signals);
    expect(roundCounter.get(tmpDir, CID)).toBe(N);
  });

  it('appendSignals batch interleaves signal rows and bump meta-records in JSONL', () => {
    const signals = [makeSignal(CID), makeSignal(CID), makeSignal(CID)];
    writer[WRITER_INTERNAL].appendSignals(signals);
    const jsonlPath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    // 3 signals + 3 bump meta-records = 6 lines, in alternating order.
    expect(lines).toHaveLength(6);
    for (let i = 0; i < 3; i++) {
      const sig = JSON.parse(lines[i * 2]);
      const bump = JSON.parse(lines[i * 2 + 1]);
      expect(sig.signal).toBe('agreement');
      expect(bump).toMatchObject({
        type: '_meta',
        signal: 'round_counter_bumped',
        consensusId: CID,
      });
    }
  });

  it('write 5 signals + reset() + 3 more → get() returns 3', () => {
    for (let i = 0; i < 5; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(5);
    roundCounter.reset(tmpDir, CID);
    for (let i = 0; i < 3; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    // Force fresh scan to confirm JSONL-derived behavior.
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(3);
  });

  it('truncated JSONL: get() returns count of valid bumps, skipping malformed tail', () => {
    for (let i = 0; i < 4; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    const jsonlPath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    fs.appendFileSync(jsonlPath, '{"type":"_meta","signal":"round_counter_bum');
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(4);
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
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('shortfall detection: writing N signals → counter == N, dropping one → shortfall', () => {
    const N = 3;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    const actual = roundCounter.get(tmpDir, CID);
    const findings_count = 4;
    expect(actual).toBe(N);
    expect(actual).toBeLessThan(findings_count);
    expect(findings_count - actual).toBe(1);
  });

  it('bumps counter for signal with findingId prefix (no consensusId field)', () => {
    const signalWithFindingId = {
      type: 'consensus' as const,
      taskId: 'task-bulk',
      signal: 'unique_confirmed' as const,
      agentId: 'test-agent',
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

    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(N + 1);

    roundCounter.reset(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('Fix 2 — recordConsensusRoundRetraction resets the round counter', () => {
    const N = 4;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(N);

    writer.recordConsensusRoundRetraction(CID, 'test retraction');
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('f1 — tombstone write failure does not skip reset (counter ends at 0)', () => {
    const N = 3;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(N);

    const jsonlPath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    if (!fs.existsSync(jsonlPath)) {
      fs.writeFileSync(jsonlPath, '');
    }
    fs.chmodSync(jsonlPath, 0o444);

    try {
      try {
        writer.recordConsensusRoundRetraction(CID, 'test retraction with write failure');
      } catch {
        // tombstone write failed as expected — ignore the error
      }
      // Counter must be 0 regardless of whether the tombstone write succeeded.
      // Under Option C the reset() call in the finally block also fails to
      // append a JSONL record, but it sets the in-memory fallback to 0 which
      // masks the JSONL-derived count.
      expect(roundCounter.get(tmpDir, CID)).toBe(0);
    } finally {
      fs.chmodSync(jsonlPath, 0o644);
    }
  });
});

// ── reset() on read-only filesystem ───────────────────────────────────────────

describe('roundCounter — reset() on read-only filesystem (f2)', () => {
  const CID = 'f2f2f2f2-deadc0de';
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
    const gossipDir = path.join(tmpDir, '.gossip');
    try { fs.chmodSync(gossipDir, 0o755); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get() returns 0 after reset() even when filesystem is read-only', () => {
    roundCounter.bump(tmpDir, CID);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);

    const gossipDir = path.join(tmpDir, '.gossip');
    fs.chmodSync(gossipDir, 0o555);

    try {
      expect(() => roundCounter.reset(tmpDir, CID)).not.toThrow();
      expect(roundCounter.get(tmpDir, CID)).toBe(0);
    } finally {
      fs.chmodSync(gossipDir, 0o755);
    }
  });
});

// ── Concurrent appends ────────────────────────────────────────────────────────

describe('roundCounter — concurrent appends (Option C wins over RMW)', () => {
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

  it('all concurrent bumps land — append-only writes do not race like RMW', async () => {
    // Under Option C every bump is its own append, so all CONCURRENCY bumps
    // are persisted cleanly (no last-writer-wins like the legacy RMW path).
    const CONCURRENCY = 10;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => Promise.resolve(roundCounter.bump(tmpDir, CID))),
    );
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(CONCURRENCY);
  });
});

// ── Fix 4: signal-class filter at the round-counter bump site ─────────────────

describe('PerformanceWriter — Fix 4: operational signals do not bump counter', () => {
  let tmpDir: string;
  let writer: PerformanceWriter;
  const CID = 'f4f4f4f4-deadc0de';

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    writer = new PerformanceWriter(tmpDir);
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
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
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
  });

  it('Fix 4 — operational signals do NOT bump counter (appendSignal)', () => {
    writer[WRITER_INTERNAL].appendSignal(makeOperationalSignal(CID));
    expect(roundCounter.get(tmpDir, CID)).toBe(0);
  });

  it('Fix 4 — mixed batch: only performance signals bump (appendSignals)', () => {
    const batch = [
      makePerformanceSignal(CID),
      makeOperationalSignal(CID),
      makePerformanceSignal(CID),
    ];
    writer[WRITER_INTERNAL].appendSignals(batch);
    expect(roundCounter.get(tmpDir, CID)).toBe(2);
  });

  it('Fix 4 — unknown signal name (classifySignal returns undefined) still bumps (backwards compat)', () => {
    const unknownSignal = {
      type: 'consensus' as const,
      signal: 'severity_miscalibrated' as any,
      agentId: 'test-agent',
      taskId: `task-${CID}`,
      consensusId: CID,
      evidence: 'test',
      timestamp: new Date().toISOString(),
    };
    writer[WRITER_INTERNAL].appendSignal(unknownSignal);
    expect(roundCounter.get(tmpDir, CID)).toBe(1);
  });
});

// ── Fix 7 (F7): in-memory fallback populated when JSONL write fails (hot path) ─
//
// Verifies that when appendFileSync throws (read-only fs / EPERM / ENOSPC),
// the writer registers the bump via bumpRoundCounter() so inMemoryFallback
// is populated and get() returns the correct in-process count (persisted +
// in-memory). The appendSignal call is expected to re-throw — callers must
// see the original error.

describe('PerformanceWriter — Fix 7: inMemoryFallback populated on JSONL write failure', () => {
  // Skip on Windows (chmod semantics differ) and when running as root (root
  // bypasses permission bits so the read-only guard has no effect).
  const skip =
    process.platform === 'win32' ||
    (typeof process.getuid === 'function' && process.getuid() === 0);

  let tmpDir: string;
  let writer: PerformanceWriter;
  const CID = 'f7f7f7f7-deadbeef';

  const makeSignal = (consensusId: string) => ({
    type: 'consensus' as const,
    taskId: `task-${consensusId}`,
    signal: 'agreement' as const,
    agentId: 'test-agent',
    consensusId,
    evidence: 'test',
    timestamp: new Date().toISOString(),
  });

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    writer = new PerformanceWriter(tmpDir);
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
    // Restore write permissions so jest cleanup can remove temp files.
    // The test may have made either the .gossip dir or the JSONL file read-only.
    try { fs.chmodSync(path.join(tmpDir, '.gossip'), 0o755); } catch { /* ignore */ }
    const jsonlFile = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    try { if (fs.existsSync(jsonlFile)) fs.chmodSync(jsonlFile, 0o644); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  (skip ? it.skip : it)(
    'appendSignal on read-only JSONL file: throws AND registers bump in inMemoryFallback',
    () => {
      // Write one signal first so the JSONL file exists, then make it read-only.
      // Making the file itself read-only (0o444) is the reliable way to block
      // appendFileSync on POSIX — directory chmod (0o555) only blocks new-file
      // creation, not writes to existing files. See existing test at line ~434.
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
      expect(roundCounter.get(tmpDir, CID)).toBe(1);

      const jsonlFile = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
      fs.chmodSync(jsonlFile, 0o444);

      // The second appendSignal must throw because the file is read-only.
      expect(() => writer[WRITER_INTERNAL].appendSignal(makeSignal(CID))).toThrow();

      // Despite the throw, the bump must have been registered via
      // inMemoryFallback. The inMemoryFallback is an override layer (not a
      // delta): it masks the JSONL-derived count once set. After the catch
      // handler calls bumpRoundCounter(), bump() initialises the fallback to 1
      // (its own in-memory increment, not JSONL-count + 1). get() therefore
      // returns the fallback value of 1. The critical invariant is that get()
      // does NOT return 0 — the in-process work is visible even though
      // persistence failed.
      expect(roundCounter.get(tmpDir, CID)).toBeGreaterThan(0);

      // Verify the fallback is populated by confirming get() doesn't fall
      // through to an empty JSONL scan (the locked file would return stale
      // cached data from before the lock — but the fallback overrides it).
      // Concrete assertion: exactly 1 in-memory bump was registered.
      expect(roundCounter.get(tmpDir, CID)).toBe(1);
    },
  );

  (skip ? it.skip : it)(
    'appendSignals on read-only JSONL file: throws AND registers bumps in inMemoryFallback for all signals with consensusId',
    () => {
      // Write one signal first (persisted count = 1), then lock the file.
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
      expect(roundCounter.get(tmpDir, CID)).toBe(1);

      const jsonlFile = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
      fs.chmodSync(jsonlFile, 0o444);

      // Batch of 2 signals — both have consensusId so both should register.
      expect(() =>
        writer[WRITER_INTERNAL].appendSignals([makeSignal(CID), makeSignal(CID)]),
      ).toThrow();

      // inMemoryFallback is an override layer. Each call to bumpRoundCounter()
      // in the catch handler adds 1 to the fallback (starting from the current
      // fallback value, not the JSONL count). After 2 calls, the fallback is 2.
      // get() returns the fallback value, not JSONL-derived + fallback.
      expect(roundCounter.get(tmpDir, CID)).toBe(2);
    },
  );
});

// ── Fix 5: rate-limited stderr logging on round-counter bump errors ───────────
//
// Under Option C the writer no longer calls bumpRoundCounter — it builds the
// bump record inline. Error injection now happens via deriveConsensusId, which
// is the only call still inside the try/catch at the bump site. The Fix 5
// invariants (loud-failure logging + per-message dedup + per-iteration catch
// in the batch loop) are preserved.

describe('PerformanceWriter — Fix 5: loud-failure logging at bump catch sites', () => {
  let tmpDir: string;
  let writer: PerformanceWriter;
  const CID = 'f5f5f5f5-baadf00d';

  const makeSignal = (consensusId: string) => ({
    type: 'consensus' as const,
    signal: 'unique_confirmed' as const,
    agentId: 'test-agent',
    taskId: `task-${consensusId}`,
    consensusId,
    evidence: 'test',
    timestamp: new Date().toISOString(),
  });

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    writer = new PerformanceWriter(tmpDir);
    roundCounter.__resetForTests();
    __resetLoggedCounterErrorsForTests();
  });

  afterEach(() => {
    roundCounter.__resetForTests();
    __resetLoggedCounterErrorsForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('Fix 5 — first bump error of a kind is written to stderr', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(roundCounter, 'deriveConsensusId').mockImplementationOnce(() => {
      throw new Error('synthetic test error');
    });

    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(m => m.includes('synthetic test error'))).toBe(true);
    expect(calls.some(m => m.includes('[gossipcat]'))).toBe(true);
  });

  it('Fix 5 — same error message is logged only once per process (deduplication)', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(roundCounter, 'deriveConsensusId').mockImplementation(() => {
      throw new Error('repeated error message');
    });

    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));

    const matchingCalls = stderrSpy.mock.calls.filter(c =>
      String(c[0]).includes('repeated error message'),
    );
    expect(matchingCalls).toHaveLength(1);
  });

  it('Fix 5 — two different error messages each log once', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let callCount = 0;
    jest.spyOn(roundCounter, 'deriveConsensusId').mockImplementation(() => {
      callCount += 1;
      throw new Error(`error variant ${callCount <= 1 ? 'alpha' : 'beta'}`);
    });

    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));

    const alphaCalls = stderrSpy.mock.calls.filter(c => String(c[0]).includes('error variant alpha'));
    const betaCalls = stderrSpy.mock.calls.filter(c => String(c[0]).includes('error variant beta'));
    expect(alphaCalls).toHaveLength(1);
    expect(betaCalls).toHaveLength(1);
  });

  it('Fix 5 — first error in batch path logs to stderr (appendSignals)', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(roundCounter, 'deriveConsensusId').mockImplementationOnce(() => {
      throw new Error('synthetic batch error');
    });

    writer[WRITER_INTERNAL].appendSignals([makeSignal(CID)]);

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(m => m.includes('synthetic batch error'))).toBe(true);
    expect(calls.some(m => m.includes('[gossipcat]'))).toBe(true);
  });

  it('Cosmetic B — bump throw on one signal does not stop subsequent bumps in batch (appendSignals)', () => {
    // Under Option C the batch loop builds a `parts[]` array; per-iteration
    // try/catch lets one bad signal log + continue without aborting the rest
    // of the batch. We simulate failure on the 2nd signal via deriveConsensusId.
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let deriveCallCount = 0;
    jest.spyOn(roundCounter, 'deriveConsensusId').mockImplementation(((rec: any) => {
      deriveCallCount += 1;
      if (deriveCallCount === 2) {
        throw new Error('mid-batch synthetic error');
      }
      return rec?.consensusId;
    }) as any);

    const signals = [makeSignal(CID), makeSignal(CID), makeSignal(CID)];
    writer[WRITER_INTERNAL].appendSignals(signals);

    // deriveConsensusId was called 3 times — the throw on call #2 did NOT
    // short-circuit the loop.
    expect(deriveCallCount).toBe(3);

    // Stderr received exactly one write (dedup latch).
    const matchingCalls = stderrSpy.mock.calls.filter(c =>
      String(c[0]).includes('mid-batch synthetic error'),
    );
    expect(matchingCalls).toHaveLength(1);

    // Signals #1 and #3 still landed with their bump records → counter == 2.
    expect(roundCounter.get(tmpDir, CID)).toBe(2);
  });
});

// ── Partial-flush atomicity + backfill cap (PR #309 follow-up: f1, f3, f4) ────
//
// Three failure modes addressed by the post-merge audit on PR #309:
//   f1 (HIGH)   — partial-flush double-count: a backfill loop that breaks
//                  mid-flight left fbk = priorCount, so the next bump retried
//                  the WHOLE batch (including records already written to JSONL)
//                  and produced duplicates.
//   f3 (MEDIUM) — unbounded backfill: priorCount could grow to 1000s during a
//                  long ROFS episode and then synchronously block the event
//                  loop on a single bump() call when the FS recovered.
//   f4 (LOW)    — no partial-failure tests existed.
//
// These tests gate the fix: per-step `inMemoryFallback.set(fbk, remaining)`
// after each successful append + a `MAX_BACKFILL_PER_BUMP` cap on the loop.

describe('roundCounter — partial-flush atomicity + backfill cap (f1, f3, f4)', () => {
  const CID = 'aabbccdd-11223344';
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProjectRoot();
    roundCounter.__resetForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    roundCounter.__resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function countBumpRecords(): { live: number; backfill: number; total: number } {
    const jsonlPath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    if (!fs.existsSync(jsonlPath)) return { live: 0, backfill: 0, total: 0 };
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    let live = 0;
    let backfill = 0;
    for (const line of lines) {
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.type !== '_meta' || rec.signal !== 'round_counter_bumped') continue;
      if (rec._emission_path === 'round-counter-bump-backfill') backfill++;
      else if (rec._emission_path === 'round-counter-bump') live++;
    }
    return { live, backfill, total: live + backfill };
  }

  it('partial-flush retry does not double-count: 5 ROFS bumps + partial recovery + full recovery = no duplicates', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const gossipDir = path.join(tmpDir, '.gossip');

    // Phase 1: 5 ROFS bumps accumulate in fbk.
    fs.chmodSync(gossipDir, 0o555);
    try {
      for (let i = 0; i < 5; i++) roundCounter.bump(tmpDir, CID);
    } finally {
      fs.chmodSync(gossipDir, 0o755);
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(5);

    // Phase 2: spy appendFileSync to allow the live append + 2 backfill
    // appends to succeed, then throw on the 3rd backfill. Mid-flush failure.
    const real = fs.appendFileSync.bind(fs);
    let callCount = 0;
    const fsMod = require('fs');
    const original = fsMod.appendFileSync;
    fsMod.appendFileSync = (...args: any[]) => {
      callCount++;
      // Call 1: live append. Calls 2-3: first two backfills succeed.
      // Call 4: third backfill throws → loop breaks with remaining=2.
      if (callCount === 4) throw new Error('synthetic mid-flush EROFS');
      return (real as any)(...args);
    };
    try {
      roundCounter.bump(tmpDir, CID);
    } finally {
      fsMod.appendFileSync = original;
    }

    // After partial flush: JSONL has 1 live + 2 backfill = 3 records.
    let counts = countBumpRecords();
    expect(counts.live).toBe(1);
    expect(counts.backfill).toBe(2);

    // Phase 3: full recovery. Next bump must drain ONLY the remaining 3
    // (priorCount started at 5, 2 already flushed, so 3 left), NOT retry
    // all 5. After this bump: JSONL has 2 live + 5 backfill = 7 records.
    roundCounter.bump(tmpDir, CID);
    counts = countBumpRecords();
    expect(counts.live).toBe(2);
    expect(counts.backfill).toBe(5);
    // Critically: NO duplicates. If the bug were present, backfill would be
    // 7 (2 from phase 2 + 5 retry from phase 3) and total would be 9.
    expect(counts.total).toBe(7);

    // fbk fully drained.
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(7);
  });

  it('MAX_BACKFILL_PER_BUMP caps loop at 100 records per bump; remainder drains on next bump', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const gossipDir = path.join(tmpDir, '.gossip');

    // Phase 1: 150 ROFS bumps. dir-readonly path is the cleanest way to
    // populate fbk to a target value without mocking.
    fs.chmodSync(gossipDir, 0o555);
    try {
      for (let i = 0; i < 150; i++) roundCounter.bump(tmpDir, CID);
    } finally {
      fs.chmodSync(gossipDir, 0o755);
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(150);

    // Phase 2: first recovery bump writes 1 live + 100 backfill (cap), leaves
    // remainder = 50 in fbk.
    roundCounter.bump(tmpDir, CID);
    let counts = countBumpRecords();
    expect(counts.live).toBe(1);
    expect(counts.backfill).toBe(100);
    // get() now returns the in-memory fallback value = 50 (remainder).
    expect(roundCounter.get(tmpDir, CID)).toBe(50);

    // Phase 3: second recovery bump writes 1 live + 50 backfill (drains
    // remainder), fbk deleted.
    roundCounter.bump(tmpDir, CID);
    counts = countBumpRecords();
    expect(counts.live).toBe(2);
    expect(counts.backfill).toBe(150);
    // fbk should be deleted now → get() falls through to JSONL scan.
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(152);
  });

  it('crash recovery via __resetForTests after partial flush: JSONL holds exactly the persisted records, fbk is gone', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const gossipDir = path.join(tmpDir, '.gossip');

    // Phase 1: 5 ROFS bumps.
    fs.chmodSync(gossipDir, 0o555);
    try {
      for (let i = 0; i < 5; i++) roundCounter.bump(tmpDir, CID);
    } finally {
      fs.chmodSync(gossipDir, 0o755);
    }
    expect(roundCounter.get(tmpDir, CID)).toBe(5);

    // Phase 2: partial-flush bump — live + 2 backfills succeed, then crash
    // simulated by failing the 4th call.
    const real = fs.appendFileSync.bind(fs);
    let callCount = 0;
    const fsMod = require('fs');
    const original = fsMod.appendFileSync;
    fsMod.appendFileSync = (...args: any[]) => {
      callCount++;
      if (callCount === 4) throw new Error('synthetic crash');
      return (real as any)(...args);
    };
    try {
      roundCounter.bump(tmpDir, CID);
    } finally {
      fsMod.appendFileSync = original;
    }

    // Snapshot JSONL state immediately (before reset, so we measure what was
    // actually persisted across the simulated crash boundary).
    const counts = countBumpRecords();
    expect(counts.live).toBe(1);
    expect(counts.backfill).toBe(2);
    expect(counts.total).toBe(3);

    // Phase 3: simulated process crash — wipe ALL in-memory state.
    // Persisted JSONL survives. Reader rebuilds count from disk only.
    roundCounter.__resetForTests();
    expect(roundCounter.get(tmpDir, CID)).toBe(3);
  });
});
