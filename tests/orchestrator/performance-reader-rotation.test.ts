// @gossip:impact-adjacent:signal-pipeline
/**
 * Tests for the readJsonlWithRotated helper and migration of PerformanceReader
 * methods to use it — Phase A fix for the signal-log-rotation data-loss bug
 * (consensus 8cc22d50-93ab4d73).
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readJsonlWithRotated, PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import * as RoundCounter from '../../packages/orchestrator/src/round-counter';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gossip-rotation-test-'));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

// ── readJsonlWithRotated unit tests ──────────────────────────────────────────

describe('readJsonlWithRotated', () => {
  it('returns empty string when neither file exists', () => {
    const result = readJsonlWithRotated(join(tmpDir, 'missing.jsonl'));
    expect(result).toBe('');
  });

  it('returns live content when only live file exists', () => {
    const liveFile = join(tmpDir, 'perf.jsonl');
    writeFileSync(liveFile, '{"a":1}\n{"b":2}\n');
    const result = readJsonlWithRotated(liveFile);
    expect(result).toBe('{"a":1}\n{"b":2}\n');
  });

  it('returns rotated content when only .1 file exists', () => {
    const liveFile = join(tmpDir, 'perf.jsonl');
    writeFileSync(liveFile + '.1', '{"old":1}\n{"old":2}\n');
    const result = readJsonlWithRotated(liveFile);
    expect(result).toBe('{"old":1}\n{"old":2}\n');
  });

  it('concatenates .1 (older) before live when both exist', () => {
    const liveFile = join(tmpDir, 'perf.jsonl');
    writeFileSync(liveFile + '.1', '{"older":1}\n');
    writeFileSync(liveFile, '{"newer":2}\n');
    const result = readJsonlWithRotated(liveFile);
    expect(result).toBe('{"older":1}\n{"newer":2}\n');
    // rotated content must come FIRST (older = lower offset)
    expect(result.indexOf('"older"')).toBeLessThan(result.indexOf('"newer"'));
  });

  it('inserts separator newline when .1 content lacks trailing newline', () => {
    const liveFile = join(tmpDir, 'perf.jsonl');
    // .1 file without trailing newline
    writeFileSync(liveFile + '.1', '{"older":1}');
    writeFileSync(liveFile, '{"newer":2}\n');
    const result = readJsonlWithRotated(liveFile);
    // The two JSON objects should be on separate lines
    const lines = result.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ older: 1 });
    expect(JSON.parse(lines[1])).toEqual({ newer: 2 });
  });
});

// ── PerformanceReader.readSignals migration smoke test ───────────────────────

describe('PerformanceReader — reads signals from both live and rotated files', () => {
  function makeSignal(agentId: string, signal: string, daysAgo = 1): string {
    const ts = new Date(Date.now() - daysAgo * 86400000).toISOString();
    return JSON.stringify({
      type: 'consensus',
      agentId,
      signal,
      taskId: 'task-abc',
      timestamp: ts,
    });
  }

  it('getScores counts signals from both live and .1 when both exist', () => {
    const gossipDir = join(tmpDir, '.gossip');
    const { mkdirSync } = require('fs');
    mkdirSync(gossipDir, { recursive: true });

    const perfPath = join(gossipDir, 'agent-performance.jsonl');

    // Write 3 agreement signals to the rotated .1 slot
    const rotatedContent = [
      makeSignal('agent-x', 'agreement'),
      makeSignal('agent-x', 'agreement'),
      makeSignal('agent-x', 'agreement'),
    ].join('\n') + '\n';
    writeFileSync(perfPath + '.1', rotatedContent);

    // Write 2 agreement signals to the live slot
    const liveContent = [
      makeSignal('agent-x', 'agreement'),
      makeSignal('agent-x', 'agreement'),
    ].join('\n') + '\n';
    writeFileSync(perfPath, liveContent);

    const reader = new PerformanceReader(tmpDir);
    const scores = reader.getScores();
    const agentScore = scores.get('agent-x');

    expect(agentScore).toBeDefined();
    // Should see all 5 signals (3 from .1 + 2 from live)
    expect(agentScore!.totalSignals).toBe(5);
  });

  it('getScores returns signals from .1 even when live file is empty', () => {
    const gossipDir = join(tmpDir, '.gossip');
    mkdirSync(gossipDir, { recursive: true });

    const perfPath = join(gossipDir, 'agent-performance.jsonl');

    // Only the rotated slot exists (simulates post-rotation before new writes)
    const rotatedContent = [
      makeSignal('agent-y', 'agreement'),
      makeSignal('agent-y', 'unique_confirmed'),
    ].join('\n') + '\n';
    writeFileSync(perfPath + '.1', rotatedContent);
    // No live file

    const reader = new PerformanceReader(tmpDir);
    const scores = reader.getScores();
    const agentScore = scores.get('agent-y');

    expect(agentScore).toBeDefined();
    expect(agentScore!.totalSignals).toBe(2);
  });
});

// ── Integration: all 7 migrated readers see signals from both live and .1 ────

describe('Phase A completeness — migrated readers see rotated signals', () => {
  beforeEach(() => RoundCounter.__resetForTests());

  function makeImplSignal(agentId: string, signal: string, daysAgo = 1): string {
    const ts = new Date(Date.now() - daysAgo * 86400000).toISOString();
    return JSON.stringify({ type: 'impl', agentId, signal, timestamp: ts });
  }

  function makeRoundBump(consensusId: string): string {
    return JSON.stringify({ type: '_meta', signal: 'round_counter_bumped', consensusId, timestamp: new Date().toISOString() });
  }

  it('getImplScore and scanJsonl (round-counter.get) each recover signals from the .1 slot', () => {
    const gossipDir = join(tmpDir, '.gossip');
    mkdirSync(gossipDir, { recursive: true });
    const perfPath = join(gossipDir, 'agent-performance.jsonl');

    // Rotated slot: 2 impl_test_pass + 2 round_counter_bumped for consensusId 'cid-a'
    const rotated = [
      makeImplSignal('agent-z', 'impl_test_pass'),
      makeImplSignal('agent-z', 'impl_test_pass'),
      makeRoundBump('cid-a'),
      makeRoundBump('cid-a'),
    ].join('\n') + '\n';
    writeFileSync(perfPath + '.1', rotated);

    // Live slot: 1 more impl_test_pass + 1 more round bump
    const live = [
      makeImplSignal('agent-z', 'impl_test_pass'),
      makeRoundBump('cid-a'),
    ].join('\n') + '\n';
    writeFileSync(perfPath, live);

    // getImplScore — should see all 3 passes (2 from .1, 1 from live)
    const reader = new PerformanceReader(tmpDir);
    const implScore = reader.getImplScore('agent-z');
    expect(implScore).not.toBeNull();
    expect(implScore!.passRate).toBeCloseTo(1.0, 5); // 3/3 pass

    // scanJsonl via round-counter.get — should see 3 bumps (2 from .1, 1 from live)
    const count = RoundCounter.get(tmpDir, 'cid-a');
    expect(count).toBe(3);
  });
});
