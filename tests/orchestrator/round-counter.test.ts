// tests/orchestrator/round-counter.test.ts
//
// Unit and integration-lite tests for Phase A self-telemetry: round-counter
// module (bump / get / reset / deriveConsensusId) + performanceWriter wiring.

import * as roundCounter from '../../packages/orchestrator/src/round-counter';
import { PerformanceWriter } from '@gossip/orchestrator';
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Unit: bump / get / reset ──────────────────────────────────────────────────

describe('roundCounter — bump / get / reset', () => {
  const CID = 'aabbccdd-11223344';

  afterEach(() => {
    roundCounter.reset(CID);
  });

  it('get returns 0 for an unknown consensusId', () => {
    expect(roundCounter.get(CID)).toBe(0);
  });

  it('bump increments by 1 each call', () => {
    roundCounter.bump(CID);
    expect(roundCounter.get(CID)).toBe(1);
    roundCounter.bump(CID);
    expect(roundCounter.get(CID)).toBe(2);
  });

  it('reset removes the entry', () => {
    roundCounter.bump(CID);
    roundCounter.bump(CID);
    roundCounter.reset(CID);
    expect(roundCounter.get(CID)).toBe(0);
  });

  it('different consensusIds are tracked independently', () => {
    const CID2 = 'deadbeef-cafebabe';
    try {
      roundCounter.bump(CID);
      roundCounter.bump(CID);
      roundCounter.bump(CID2);
      expect(roundCounter.get(CID)).toBe(2);
      expect(roundCounter.get(CID2)).toBe(1);
    } finally {
      roundCounter.reset(CID2);
    }
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-rc-'));
    fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
    writer = new PerformanceWriter(tmpDir);
    roundCounter.reset(CID);
  });

  afterEach(() => {
    roundCounter.reset(CID);
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
    expect(roundCounter.get(CID)).toBe(1);
    writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    expect(roundCounter.get(CID)).toBe(2);
  });

  it('bumps counter for each signal in appendSignals', () => {
    const signals = [makeSignal(CID), makeSignal(CID), makeSignal(CID)];
    writer[WRITER_INTERNAL].appendSignals(signals);
    expect(roundCounter.get(CID)).toBe(3);
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
    expect(roundCounter.get(CID)).toBe(0);
  });

  it('shortfall detection: writing N signals → counter == N, dropping one → shortfall', () => {
    // Simulate writing 3 signals for a round with 4 findings
    const N = 3;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    const actual = roundCounter.get(CID);
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
    expect(roundCounter.get(CID)).toBe(1);
  });

  it('reset after signal_loss_suspected emit leaves counter at 0 (Fix 2 — counter reset)', () => {
    // Simulate the shortfall path from collect.ts: 3 signals written for a
    // round that had 4 findings → shortfall detected → signal_loss_suspected
    // emitted (which self-bumps the counter) → resetRoundCounter called.
    // After the reset a retry / Phase B reader must see a fresh counter (0).
    const N = 3;
    for (let i = 0; i < N; i++) {
      writer[WRITER_INTERNAL].appendSignal(makeSignal(CID));
    }
    expect(roundCounter.get(CID)).toBe(N);

    // Mimic the self-bump that emitPipelineSignals causes when it writes the
    // signal_loss_suspected diagnostic (pipeline signal carries consensusId).
    roundCounter.bump(CID);
    expect(roundCounter.get(CID)).toBe(N + 1);

    // Fix 2: resetRoundCounter is called immediately after emitPipelineSignals.
    roundCounter.reset(CID);
    expect(roundCounter.get(CID)).toBe(0);
  });
});
