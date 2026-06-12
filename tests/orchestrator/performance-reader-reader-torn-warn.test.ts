// @gossip:impact-adjacent:signal-pipeline
/**
 * Torn-line warn parity for the raw-JSONL readers migrated to parseJsonlLines:
 * getRetractedConsensusIds / getRoundRetractions / getImplScore. Before the
 * migration these silently dropped unparseable lines; now they emit the shared
 * rate-limited `[performance-reader] dropped N unparseable JSONL line(s)` warn
 * via parseJsonlLines — same throttling key (this.filePath) as readSignals.
 *
 * Fix for consensus 4ee5ced2-b654497a (f4/f10) + 8b23a8f3-2cc348d1 (f16).
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  PerformanceReader,
  __resetWarnRateLimiterForTests,
} from '../../packages/orchestrator/src/performance-reader';

const TMP = join(__dirname, '..', '..', '.test-tmp-reader-torn-warn');
const GOSSIP_FILE = join(TMP, '.gossip', 'agent-performance.jsonl');

/** Write raw JSONL lines verbatim — torn lines must survive as written. */
function writeRaw(lines: string[]): void {
  mkdirSync(join(TMP, '.gossip'), { recursive: true });
  writeFileSync(GOSSIP_FILE, lines.join('\n'));
}

const nowIso = new Date().toISOString();

describe('performance-reader raw-JSONL readers — torn-line warn parity', () => {
  let warnSpy: jest.SpyInstance;

  function tornWarnCalls(): unknown[][] {
    return warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('unparseable JSONL line(s)'),
    );
  }

  beforeEach(() => {
    __resetWarnRateLimiterForTests();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    try {
      rmSync(TMP, { recursive: true });
    } catch {
      /* best-effort */
    }
  });

  it('getRetractedConsensusIds emits the dropped-line warn AND still returns valid tombstones', () => {
    writeRaw([
      JSON.stringify({ type: 'consensus', signal: 'consensus_round_retracted', consensus_id: 'abc-123' }),
      '{ this line is torn',
      JSON.stringify({ type: 'consensus', signal: 'consensus_round_retracted', consensus_id: 'def-456' }),
    ]);

    const reader = new PerformanceReader(TMP);
    const ids = reader.getRetractedConsensusIds();

    // Parsing unchanged: both well-formed tombstones survive the torn line.
    expect(ids).toEqual(new Set(['abc-123', 'def-456']));

    const warns = tornWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain('dropped 1 unparseable JSONL line(s)');
    expect(warns[0][0]).toContain('agent-performance.jsonl');
  });

  it('getRoundRetractions emits the dropped-line warn AND still returns valid retractions', () => {
    writeRaw([
      JSON.stringify({
        type: 'consensus',
        signal: 'consensus_round_retracted',
        consensus_id: 'abc-123',
        reason: 'bad round',
        retracted_at: nowIso,
      }),
      '}{ torn payload',
      JSON.stringify({
        type: 'consensus',
        signal: 'consensus_round_retracted',
        consensus_id: 'abc-123',
        reason: 'second reason',
        retracted_at: nowIso,
      }),
    ]);

    const reader = new PerformanceReader(TMP);
    const out = reader.getRoundRetractions();

    // Duplicates preserved (admin view), torn line dropped.
    expect(out).toEqual([
      { consensus_id: 'abc-123', reason: 'bad round', retracted_at: nowIso },
      { consensus_id: 'abc-123', reason: 'second reason', retracted_at: nowIso },
    ]);

    const warns = tornWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain('dropped 1 unparseable JSONL line(s)');
  });

  it('getImplScore emits the dropped-line warn AND still computes the score from valid impl signals', () => {
    writeRaw([
      JSON.stringify({ type: 'impl', agentId: 'opus-implementer', signal: 'impl_test_pass', timestamp: nowIso }),
      'not valid json at all',
      JSON.stringify({ type: 'impl', agentId: 'opus-implementer', signal: 'impl_test_fail', timestamp: nowIso }),
      JSON.stringify({ type: 'impl', agentId: 'opus-implementer', signal: 'impl_test_pass', timestamp: nowIso }),
    ]);

    const reader = new PerformanceReader(TMP);
    const score = reader.getImplScore('opus-implementer');

    // 2 pass + 1 fail → passRate 2/3; parsing unchanged despite the torn line.
    expect(score).not.toBeNull();
    expect(score!.passRate).toBeCloseTo(2 / 3, 5);

    const warns = tornWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain('dropped 1 unparseable JSONL line(s)');
  });

  it('rate-limits across readers sharing the same file — one warn total within the window', () => {
    writeRaw([
      JSON.stringify({ type: 'consensus', signal: 'consensus_round_retracted', consensus_id: 'abc-123' }),
      '{ torn',
      JSON.stringify({ type: 'impl', agentId: 'opus-implementer', signal: 'impl_test_pass', timestamp: nowIso }),
    ]);

    const reader = new PerformanceReader(TMP);
    // Two reads of the same torn file via different readers, same window.
    reader.getImplScore('opus-implementer');
    reader.getRetractedConsensusIds();

    // Shared this.filePath rate-limit key ⇒ the second read is suppressed.
    expect(tornWarnCalls()).toHaveLength(1);
  });
});
