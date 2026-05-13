// @gossip:impact-adjacent:signal-pipeline
/**
 * Tests for the same-ms mtime race guard in PerformanceReader.getScores().
 *
 * PR #372 (consensus e72d8085-6cfb4ff6, gemini f1/f5/f9 + sonnet AGREE)
 * shipped a +1ms Date.now() guard in signal-aggregate-index.ts:136 to prevent
 * a write landing in the same integer-ms tick as the stat from producing a
 * stale cache hit. This test suite verifies the sibling fix in
 * performance-reader.ts is correct.
 *
 * Race: stat() and write() can resolve to the same mtimeMs integer when both
 * happen within the same OS clock tick. Without the guard, cachedMtimeMs ===
 * mtimeMs passes and the pre-write cache is served. The guard requires
 * Date.now() > cachedMtimeMs + 1 — at least 1ms must have elapsed since the
 * cached mtime before trusting the hit.
 */

import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  utimesSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';

let tmpDir: string;
let gossipDir: string;
let jsonlPath: string;

/** Minimal valid consensus signal payload for testing */
function makeSignal(agentId: string, signal: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'consensus',
    signal,
    agentId,
    taskId: 'task-test-001',
    evidence: 'test',
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gossip-cache-race-'));
  gossipDir = join(tmpDir, '.gossip');
  mkdirSync(gossipDir, { recursive: true });
  jsonlPath = join(gossipDir, 'agent-performance.jsonl');
});

afterEach(() => {
  jest.useRealTimers();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe('PerformanceReader.getScores() same-ms mtime race guard', () => {
  /**
   * Test A: cache populated at time T, file mtime also T, Date.now() === T+0.
   * The guard `Date.now() > cachedMtimeMs + 1` must be FALSE → cache is NOT
   * trusted → fresh read from disk is forced.
   *
   * Simulates the race window where a write lands at the same ms tick as the
   * stat, so the updated file content is on disk but the cached scores reflect
   * the pre-write state.
   */
  it('Test A: does not serve cache when Date.now() is within 1ms of cachedMtimeMs', () => {
    // Write initial content — one agreement signal for agent-alpha
    writeFileSync(
      jsonlPath,
      makeSignal('agent-alpha', 'agreement') + '\n',
    );

    const reader = new PerformanceReader(tmpDir);

    // First call — primes the cache. Use real timers for the initial read.
    const first = reader.getScores();
    expect(first.has('agent-alpha')).toBe(true);

    // Pin Date.now() to exactly cachedMtimeMs (simulates same-ms tick)
    const cachedMtime = statSync(jsonlPath).mtimeMs;

    // Now rewrite the file to add agent-beta, but keep the mtime identical
    // by forcing utimesSync back to the same timestamp. This simulates the race
    // where a write bumped mtime in the same tick as the stat.
    const updatedContent =
      makeSignal('agent-alpha', 'agreement') + '\n' +
      makeSignal('agent-beta', 'agreement') + '\n';
    writeFileSync(jsonlPath, updatedContent);
    // Force mtime back to the cached value — same integer-ms tick
    const mtimeSec = cachedMtime / 1000;
    utimesSync(jsonlPath, mtimeSec, mtimeSec);

    // Freeze Date.now() to exactly cachedMtimeMs — guard condition is false
    jest.useFakeTimers({ now: cachedMtime });

    // Second call — because Date.now() === cachedMtimeMs, guard must reject cache
    const second = reader.getScores();
    expect(second.has('agent-beta')).toBe(true);
  });

  /**
   * Test B: cache populated at time T, file unchanged, Date.now() === T+2.
   * The guard `Date.now() > cachedMtimeMs + 1` must be TRUE → cache IS trusted
   * → no disk read, same Map reference returned.
   */
  it('Test B: serves cache when >1ms has elapsed since cachedMtimeMs and file is unchanged', () => {
    writeFileSync(
      jsonlPath,
      makeSignal('agent-gamma', 'agreement') + '\n',
    );

    const reader = new PerformanceReader(tmpDir);

    // Prime the cache
    const first = reader.getScores();
    expect(first.has('agent-gamma')).toBe(true);

    const cachedMtime = statSync(jsonlPath).mtimeMs;

    // Advance time by 2ms — guard condition (Date.now() > cachedMtimeMs + 1) is true
    jest.useFakeTimers({ now: cachedMtime + 2 });

    // Second call — should return the exact same Map (cache hit, no re-read)
    const second = reader.getScores();
    expect(second).toBe(first); // referential equality → cache was returned
  });

  /**
   * Test C: boundary — Date.now() === cachedMtimeMs + 1 (exactly at the
   * boundary). The guard requires STRICTLY greater-than, so this must NOT
   * trust the cache.
   */
  it('Test C: does not serve cache when Date.now() === cachedMtimeMs + 1 (boundary, not strictly greater)', () => {
    writeFileSync(
      jsonlPath,
      makeSignal('agent-delta', 'agreement') + '\n',
    );

    const reader = new PerformanceReader(tmpDir);
    const first = reader.getScores();
    expect(first.has('agent-delta')).toBe(true);

    const cachedMtime = statSync(jsonlPath).mtimeMs;

    // Rewrite file but keep mtime at cachedMtime
    const updatedContent =
      makeSignal('agent-delta', 'agreement') + '\n' +
      makeSignal('agent-epsilon', 'agreement') + '\n';
    writeFileSync(jsonlPath, updatedContent);
    const mtimeSec = cachedMtime / 1000;
    utimesSync(jsonlPath, mtimeSec, mtimeSec);

    // Date.now() === cachedMtimeMs + 1 → strictly-greater fails → cache rejected
    jest.useFakeTimers({ now: cachedMtime + 1 });

    const second = reader.getScores();
    expect(second.has('agent-epsilon')).toBe(true);
  });
});
