import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';

const TMP = join(__dirname, '..', '..', '.test-tmp-severity');

function writeSignals(signals: object[]): void {
  mkdirSync(join(TMP, '.gossip'), { recursive: true });
  writeFileSync(join(TMP, '.gossip', 'agent-performance.jsonl'), signals.map(s => JSON.stringify(s)).join('\n'));
}

function makeSignal(overrides: Record<string, unknown> = {}) {
  return {
    type: 'consensus',
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    signal: 'unique_confirmed',
    agentId: 'agent-a',
    evidence: 'test',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => { try { rmSync(TMP, { recursive: true }); } catch {} });

describe('severity-weighted scoring', () => {
  test('critical findings produce higher reliability than medium', () => {
    const critical = Array.from({ length: 5 }, () => makeSignal({ agentId: 'agent-crit', severity: 'critical' }));
    const medium = Array.from({ length: 5 }, () => makeSignal({ agentId: 'agent-med', severity: 'medium' }));
    writeSignals([...critical, ...medium]);
    const reader = new PerformanceReader(TMP);
    const scores = reader.getScores();
    expect(scores.get('agent-crit')!.uniqueness).toBeGreaterThanOrEqual(scores.get('agent-med')!.uniqueness);
    expect(scores.get('agent-crit')!.reliability).toBeGreaterThan(scores.get('agent-med')!.reliability);
  });

  test('missing severity defaults to medium (1x)', () => {
    const explicit = Array.from({ length: 5 }, () => makeSignal({ agentId: 'a', severity: 'medium' }));
    const defaulted = Array.from({ length: 5 }, () => makeSignal({ agentId: 'b' }));
    writeSignals([...explicit, ...defaulted]);
    const reader = new PerformanceReader(TMP);
    const scores = reader.getScores();
    expect(scores.get('a')!.reliability).toBeCloseTo(scores.get('b')!.reliability, 5);
  });

  test('low severity = medium severity (floored at 1x)', () => {
    const low = Array.from({ length: 5 }, () => makeSignal({ agentId: 'a', severity: 'low' }));
    const med = Array.from({ length: 5 }, () => makeSignal({ agentId: 'b', severity: 'medium' }));
    writeSignals([...low, ...med]);
    const reader = new PerformanceReader(TMP);
    const scores = reader.getScores();
    expect(scores.get('a')!.reliability).toBeCloseTo(scores.get('b')!.reliability, 5);
  });

  test('severity does NOT scale hallucination penalty', () => {
    const signals = [
      makeSignal({ agentId: 'a', signal: 'hallucination_caught', severity: 'critical' }),
      makeSignal({ agentId: 'b', signal: 'hallucination_caught', severity: 'medium' }),
    ];
    writeSignals(signals);
    const reader = new PerformanceReader(TMP);
    const scores = reader.getScores();
    expect(scores.get('a')!.accuracy).toBeCloseTo(scores.get('b')!.accuracy, 5);
  });

  test('categoryStrengths accumulates from category_confirmed', () => {
    const signals = [
      makeSignal({ agentId: 'a', signal: 'category_confirmed', category: 'concurrency' }),
      makeSignal({ agentId: 'a', signal: 'category_confirmed', category: 'concurrency' }),
      makeSignal({ agentId: 'a', signal: 'category_confirmed', category: 'type_safety' }),
    ];
    writeSignals(signals);
    const reader = new PerformanceReader(TMP);
    const scores = reader.getScores();
    const a = scores.get('a')!;
    expect(a.categoryStrengths['concurrency']).toBeGreaterThan(0);
    expect(a.categoryStrengths['type_safety']).toBeGreaterThan(0);
    expect(a.categoryStrengths['concurrency']).toBeGreaterThan(a.categoryStrengths['type_safety']);
  });
});
