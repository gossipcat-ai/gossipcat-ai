import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';

const TMP = join(__dirname, '..', '..', '.test-tmp-diversity');

function writeSignals(signals: object[]): void {
  mkdirSync(join(TMP, '.gossip'), { recursive: true });
  writeFileSync(join(TMP, '.gossip', 'agent-performance.jsonl'), signals.map(s => JSON.stringify(s)).join('\n'));
}

const now = new Date().toISOString();
afterEach(() => { try { rmSync(TMP, { recursive: true }); } catch {} });

describe('peer diversity', () => {
  test('agent with diverse peers scores higher than agent with single peer', () => {
    const signals = [
      { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'agent-diverse', counterpartId: 'peer-1', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't2', signal: 'agreement', agentId: 'agent-diverse', counterpartId: 'peer-2', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't3', signal: 'agreement', agentId: 'agent-diverse', counterpartId: 'peer-3', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'agent-echo', counterpartId: 'peer-1', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't2', signal: 'agreement', agentId: 'agent-echo', counterpartId: 'peer-1', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't3', signal: 'agreement', agentId: 'agent-echo', counterpartId: 'peer-1', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'peer-1', counterpartId: 'agent-diverse', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't2', signal: 'agreement', agentId: 'peer-2', counterpartId: 'agent-diverse', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't3', signal: 'agreement', agentId: 'peer-3', counterpartId: 'agent-diverse', evidence: 'ok', timestamp: now },
    ];
    writeSignals(signals);
    const reader = new PerformanceReader(TMP);
    const scores = reader.getScores();
    expect(scores.get('agent-diverse')!.reliability).toBeGreaterThan(scores.get('agent-echo')!.reliability);
  });

  test('peer diversity does not apply to non-agreement signals', () => {
    const signals = [
      { type: 'consensus', taskId: 't1', signal: 'unique_confirmed', agentId: 'agent-a', evidence: 'ok', timestamp: now },
      { type: 'consensus', taskId: 't2', signal: 'unique_confirmed', agentId: 'agent-b', evidence: 'ok', timestamp: now },
    ];
    writeSignals(signals);
    const reader = new PerformanceReader(TMP);
    const scores = reader.getScores();
    expect(scores.get('agent-a')!.reliability).toBeCloseTo(scores.get('agent-b')!.reliability, 5);
  });
});

describe('getImplScore', () => {
  test('returns null when no impl signals exist', () => {
    writeSignals([{ type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'a', evidence: 'ok', timestamp: now }]);
    const reader = new PerformanceReader(TMP);
    expect(reader.getImplScore('a')).toBeNull();
  });
});
