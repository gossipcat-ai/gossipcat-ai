import { CompetencyProfiler } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function writeSignals(dir: string, signals: object[]): void {
  const data = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
  writeFileSync(join(dir, '.gossip', 'agent-performance.jsonl'), data);
}

describe('CompetencyProfiler', () => {
  const testDir = join(tmpdir(), 'gossip-profiler-' + Date.now());
  let profiler: CompetencyProfiler;

  beforeAll(() => mkdirSync(join(testDir, '.gossip'), { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  beforeEach(() => { profiler = new CompetencyProfiler(testDir); });

  test('returns null for unknown agent', () => {
    writeSignals(testDir, []);
    expect(profiler.getProfile('nonexistent')).toBeNull();
  });

  test('returns neutral profile for agent with < 10 tasks', () => {
    writeSignals(testDir, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't1', value: 5000, timestamp: '2026-01-01T00:00:00Z' },
    ]);
    const profile = profiler.getProfile('a');
    expect(profile).not.toBeNull();
    expect(profile!.totalTasks).toBe(1);
    expect(profile!.reviewReliability).toBe(0.5);
  });

  test('getProfileMultiplier returns 1.0 for agent below threshold', () => {
    writeSignals(testDir, [
      { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't1', value: 5000, timestamp: '2026-01-01T00:00:00Z' },
    ]);
    expect(profiler.getProfileMultiplier('a', 'review')).toBe(1.0);
    expect(profiler.getProfileMultiplier('a', 'impl')).toBe(1.0);
  });

  test('computes reviewStrengths from category_confirmed signals', () => {
    const signals: object[] = [];
    for (let i = 0; i < 12; i++) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
    }
    for (let i = 0; i < 5; i++) {
      signals.push({ type: 'consensus', signal: 'category_confirmed', agentId: 'a', category: 'injection_vectors', evidence: '', timestamp: '2026-01-01T00:00:00Z', taskId: `t${i}` });
    }
    writeSignals(testDir, signals);
    const profile = profiler.getProfile('a');
    expect(profile!.reviewStrengths['injection_vectors']).toBeGreaterThan(0.5);
  });

  test('computes implPassRate from impl signals', () => {
    const signals: object[] = [];
    for (let i = 0; i < 12; i++) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
    }
    for (let i = 0; i < 5; i++) {
      signals.push({ type: 'impl', signal: 'impl_test_pass', agentId: 'a', taskId: `t${i}`, timestamp: '2026-01-01T00:00:00Z' });
    }
    for (let i = 0; i < 2; i++) {
      signals.push({ type: 'impl', signal: 'impl_test_fail', agentId: 'a', taskId: `f${i}`, timestamp: '2026-01-01T00:00:00Z' });
    }
    writeSignals(testDir, signals);
    const profile = profiler.getProfile('a');
    expect(profile!.implPassRate).toBeCloseTo(5 / 7, 1);
  });

  test('handles zero impl signals — implPassRate defaults to 0.5', () => {
    const signals: object[] = [];
    for (let i = 0; i < 12; i++) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
    }
    writeSignals(testDir, signals);
    expect(profiler.getProfile('a')!.implPassRate).toBe(0.5);
  });

  test('applies score decay — recent signals have more impact', () => {
    const signals: object[] = [];
    for (let i = 0; i < 60; i++) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
    }
    signals.push({ type: 'consensus', signal: 'category_confirmed', agentId: 'a', category: 'concurrency', evidence: '', timestamp: '2026-01-01T00:00:00Z', taskId: 't0' });
    signals.push({ type: 'consensus', signal: 'category_confirmed', agentId: 'a', category: 'injection_vectors', evidence: '', timestamp: '2026-01-01T00:00:00Z', taskId: 't59' });
    writeSignals(testDir, signals);
    const profile = profiler.getProfile('a');
    expect(profile!.reviewStrengths['injection_vectors']).toBeGreaterThan(profile!.reviewStrengths['concurrency'] || 0);
  });

  test('caps score change per round at ±0.3', () => {
    const signals: object[] = [];
    for (let i = 0; i < 12; i++) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
    }
    for (let i = 0; i < 50; i++) {
      signals.push({ type: 'consensus', signal: 'agreement', agentId: 'a', counterpartId: 'b', evidence: 'ok', timestamp: '2026-01-01T00:00:00Z', taskId: 't0' });
    }
    writeSignals(testDir, signals);
    const profile = profiler.getProfile('a');
    // accuracy starts at 0.5, max ±0.3 per round
    expect(profile!.reviewReliability).toBeLessThanOrEqual(0.8 * 0.7 + 0.5 * 0.3 + 0.01);
  });

  test('applies agreement diversity discount', () => {
    // Low diversity: 10 agents exist, but 'a' only agrees with 'b'
    const signals: object[] = [];
    for (let i = 0; i < 12; i++) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
    }
    // Add other agents with consensus signals so they count as consensus participants
    const otherAgents = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
    for (const agent of otherAgents) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: agent, taskId: `${agent}-t0`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
      signals.push({ type: 'consensus', signal: 'unique_unconfirmed', agentId: agent, taskId: `${agent}-t0`, evidence: 'finding', timestamp: '2026-01-01T00:00:00Z' });
    }
    // All agreements with same peer 'b' (low diversity: 1/10 = 0.3 after min clamp)
    for (let i = 0; i < 10; i++) {
      signals.push({ type: 'consensus', signal: 'agreement', agentId: 'a', counterpartId: 'b', evidence: 'ok', timestamp: '2026-01-01T00:00:00Z', taskId: `t${i}` });
    }
    writeSignals(testDir, signals);
    const lowDiv = profiler.getProfile('a');

    // High diversity: same agents exist, 'a' agrees with all different peers
    const signals2: object[] = [];
    for (let i = 0; i < 12; i++) {
      signals2.push({ type: 'meta', signal: 'task_completed', agentId: 'a', taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
    }
    for (const agent of otherAgents) {
      signals2.push({ type: 'meta', signal: 'task_completed', agentId: agent, taskId: `${agent}-t0`, value: 3000, timestamp: '2026-01-01T00:00:00Z' });
      signals2.push({ type: 'consensus', signal: 'unique_unconfirmed', agentId: agent, taskId: `${agent}-t0`, evidence: 'finding', timestamp: '2026-01-01T00:00:00Z' });
    }
    for (let i = 0; i < 10; i++) {
      signals2.push({ type: 'consensus', signal: 'agreement', agentId: 'a', counterpartId: otherAgents[i], evidence: 'ok', timestamp: '2026-01-01T00:00:00Z', taskId: `t${i}` });
    }
    writeSignals(testDir, signals2);
    profiler = new CompetencyProfiler(testDir);
    const highDiv = profiler.getProfile('a');

    expect(highDiv!.reviewReliability).toBeGreaterThan(lowDiv!.reviewReliability);
  });

  test('skips malformed JSONL lines without crashing', () => {
    const data = '{"type":"meta","signal":"task_completed","agentId":"a","taskId":"t1","value":100,"timestamp":"2026-01-01T00:00:00Z"}\nnot valid json\n{"type":"meta","signal":"task_completed","agentId":"a","taskId":"t2","value":200,"timestamp":"2026-01-01T00:00:00Z"}\n';
    writeFileSync(join(testDir, '.gossip', 'agent-performance.jsonl'), data);
    const profile = profiler.getProfile('a');
    expect(profile).not.toBeNull();
    expect(profile!.totalTasks).toBe(2);
  });
});
