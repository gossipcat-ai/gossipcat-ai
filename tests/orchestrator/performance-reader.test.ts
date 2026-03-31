import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-perf-reader');

function writeSignals(signals: any[]): void {
  mkdirSync(join(TEST_DIR, '.gossip'), { recursive: true });
  const data = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
  writeFileSync(join(TEST_DIR, '.gossip', 'agent-performance.jsonl'), data);
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('PerformanceReader', () => {
  it('returns empty scores when no file exists', () => {
    const reader = new PerformanceReader(TEST_DIR);
    const scores = reader.getScores();
    expect(scores.size).toBe(0);
  });

  it('returns empty scores for an empty file', () => {
    writeSignals([]);
    const reader = new PerformanceReader(TEST_DIR);
    const scores = reader.getScores();
    expect(scores.size).toBe(0);
  });

  it('returns neutral weight (1.0) for unknown agent', () => {
    const reader = new PerformanceReader(TEST_DIR);
    expect(reader.getDispatchWeight('unknown-agent')).toBe(1.0);
  });

  it('returns neutral weight when fewer than 3 signals', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'rev', taskId: 't1', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'agreement', agentId: 'rev', taskId: 't2', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    expect(reader.getDispatchWeight('rev')).toBe(1.0); // not enough data
  });

  it('boosts weight for agent with agreements', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'rev', taskId: 't1', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'agreement', agentId: 'rev', taskId: 't2', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'agreement', agentId: 'rev', taskId: 't3', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'rev', taskId: 't4', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const weight = reader.getDispatchWeight('rev');
    expect(weight).toBeGreaterThan(1.0); // boosted
  });

  it('reduces weight for agent with hallucinations', () => {
    writeSignals([
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't1', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't2', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't3', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const weight = reader.getDispatchWeight('bad');
    expect(weight).toBeLessThan(1.0); // penalized
  });

  it('tracks agreement and disagreement counts', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'rev', taskId: 't1', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'disagreement', agentId: 'rev', taskId: 't2', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'rev', taskId: 't3', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'new_finding', agentId: 'rev', taskId: 't4', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('rev');
    expect(score).not.toBeNull();
    expect(score!.agreements).toBe(1);
    expect(score!.disagreements).toBe(1);
    expect(score!.uniqueFindings).toBe(2); // unique_confirmed + new_finding
    expect(score!.totalSignals).toBe(4);
  });

  it('handles malformed lines gracefully', () => {
    mkdirSync(join(TEST_DIR, '.gossip'), { recursive: true });
    const recent = new Date().toISOString();
    writeFileSync(
      join(TEST_DIR, '.gossip', 'agent-performance.jsonl'),
      `{"type":"consensus","signal":"agreement","agentId":"rev","taskId":"t1","evidence":"","timestamp":"${recent}"}\nnot json\n{"broken\n`
    );
    const reader = new PerformanceReader(TEST_DIR);
    const scores = reader.getScores();
    expect(scores.size).toBe(1); // only the valid line
    expect(scores.get('rev')!.agreements).toBe(1);
  });

  it('computes reliability as weighted accuracy + uniqueness', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'rev', taskId: 't1', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'agreement', agentId: 'rev', taskId: 't2', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'rev', taskId: 't3', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('rev')!;
    // Ratio-based: rawAccuracy = 2/2 = 1.0, accuracy = 1.0
    // Uniqueness: exponential diminishing returns. 1 unique_confirmed (0.2 weighted)
    //   = 0.5 + 0.5 * (1 - exp(-0.2 * 1.5)) ≈ 0.63
    expect(score.accuracy).toBeCloseTo(1.0, 1);
    expect(score.uniqueness).toBeGreaterThan(0.6);
    expect(score.uniqueness).toBeLessThan(0.75);
    expect(score.reliability).toBeGreaterThan(0.9);
  });

  it('clamps scores to 0-1 range', () => {
    const manyBad = Array.from({ length: 10 }, (_, i) => ({
      type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: `t${i}`, evidence: '', timestamp: new Date().toISOString(),
    }));
    const manyGood = Array.from({ length: 10 }, (_, i) => ({
      type: 'consensus', signal: 'agreement', agentId: 'good', taskId: `t${i}`, evidence: '', timestamp: new Date().toISOString(),
    }));
    writeSignals([...manyBad, ...manyGood]);
    const reader = new PerformanceReader(TEST_DIR);
    const badScore = reader.getAgentScore('bad')!;
    const goodScore = reader.getAgentScore('good')!;
    expect(badScore.accuracy).toBe(0);
    expect(goodScore.accuracy).toBe(1);
  });

  it('handles multiple agents independently', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'good', taskId: 't1', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'agreement', agentId: 'good', taskId: 't2', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'agreement', agentId: 'good', taskId: 't3', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't4', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't5', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't6', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    expect(reader.getDispatchWeight('good')).toBeGreaterThan(1.0);
    expect(reader.getDispatchWeight('bad')).toBeLessThan(1.0);
  });

  it('boosts winner accuracy and totalSignals when counterpart loses disagreement', () => {
    // Agent "loser" gets disagreement signals, counterpartId points to "winner"
    writeSignals([
      { type: 'consensus', signal: 'disagreement', agentId: 'loser', taskId: 't1', counterpartId: 'winner', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'disagreement', agentId: 'loser', taskId: 't2', counterpartId: 'winner', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'disagreement', agentId: 'loser', taskId: 't3', counterpartId: 'winner', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    // Loser: ratio = 0/3 = 0 (3 disagreements add to total but not correct)
    const loserScore = reader.getAgentScore('loser')!;
    expect(loserScore.accuracy).toBe(0);
    expect(loserScore.totalSignals).toBe(3);
    // Winner: ratio = 3/3 = 1.0 (counterpart bonus adds to weighted correct & total)
    // totalSignals counts only rows where agentId == winner — here that's 0.
    const winnerScore = reader.getAgentScore('winner')!;
    expect(winnerScore.accuracy).toBeCloseTo(1.0, 1);
    expect(winnerScore.totalSignals).toBe(0);
    // Not enough signal rows (< 3) → neutral dispatch weight
    expect(reader.getDispatchWeight('winner')).toBe(1.0);
  });

  it('ignores empty counterpartId', () => {
    writeSignals([
      { type: 'consensus', signal: 'disagreement', agentId: 'a', taskId: 't1', counterpartId: '', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'disagreement', agentId: 'a', taskId: 't2', counterpartId: null, evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'disagreement', agentId: 'a', taskId: 't3', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const scores = reader.getScores();
    // Only agent 'a' should exist — no '' or 'null' keys
    expect(scores.size).toBe(1);
    expect(scores.has('')).toBe(false);
    expect(scores.has('null')).toBe(false);
  });

  it('does not count unknown signal types toward totalSignals', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'a', taskId: 't1', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'FAKE_SIGNAL', agentId: 'a', taskId: 't2', evidence: '', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'garbage', agentId: 'a', taskId: 't3', evidence: '', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('a')!;
    expect(score.totalSignals).toBe(1); // only the valid agreement
    expect(score.agreements).toBe(1);
  });

  it('boosts uniqueness for unique_unconfirmed signals', () => {
    writeSignals([
        { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'a', taskId: 't1', timestamp: new Date().toISOString() },
        { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'a', taskId: 't2', timestamp: new Date().toISOString() },
        { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'a', taskId: 't3', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const scoreA = reader.getAgentScore('a')!;
    // 3 unique_unconfirmed: weightedUnique = 3 * 0.05 = 0.15
    // uniqueness = 0.5 + 0.5 * (1 - exp(-0.15 * 1.5)) ≈ 0.60
    expect(scoreA.uniqueness).toBeGreaterThan(0.55);
    expect(scoreA.uniqueness).toBeLessThan(0.65);
    expect(scoreA.accuracy).toBe(0.5);
  });

  it('time decay reduces good agent reliability toward 0.5', () => {
    const threeWeeksAgo = new Date(Date.now() - 21 * 86400000).toISOString();
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'good', taskId: 't1', evidence: '', timestamp: threeWeeksAgo },
      { type: 'consensus', signal: 'agreement', agentId: 'good', taskId: 't2', evidence: '', timestamp: threeWeeksAgo },
      { type: 'consensus', signal: 'agreement', agentId: 'good', taskId: 't3', evidence: '', timestamp: threeWeeksAgo },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('good')!;
    // 3 agreements = perfect accuracy, but 21 days old
    // Should decay toward 0.5 (lower than the raw ~1.0 reliability)
    expect(score.reliability).toBeGreaterThan(0.5);
    expect(score.reliability).toBeLessThan(0.8);
  });

  it('time decay slowly rehabilitates bad agents (21-day half-life)', () => {
    const threeWeeksAgo = new Date(Date.now() - 21 * 86400000).toISOString();
    writeSignals([
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't1', evidence: '', timestamp: threeWeeksAgo },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't2', evidence: '', timestamp: threeWeeksAgo },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'bad', taskId: 't3', evidence: '', timestamp: threeWeeksAgo },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('bad')!;
    // 3 hallucinations = low reliability. Bad agents DO decay toward 0.5, but at 3x slower
    // rate than good agents (21-day half-life vs 7-day). After exactly 21 days (1 half-life),
    // they are halfway back to neutral — still below 0.5 but measurably higher than raw score.
    expect(score.reliability).toBeLessThan(0.5);
  });

  it('neutral agent (0.5) is unaffected by time decay', () => {
    // An agent with no signals defaults to no score (null).
    // An agent with equal positive/negative should hover near 0.5.
    const threeWeeksAgo = new Date(Date.now() - 21 * 86400000).toISOString();
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'neutral', taskId: 't1', evidence: '', timestamp: threeWeeksAgo },
      { type: 'consensus', signal: 'disagreement', agentId: 'neutral', taskId: 't2', evidence: '', timestamp: threeWeeksAgo },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('neutral')!;
    // ~0.5 accuracy, time decay should not push it below 0.5 (since it's ~0.5 already)
    expect(score.reliability).toBeGreaterThanOrEqual(0.3);
    expect(score.reliability).toBeLessThanOrEqual(0.55);
  });
});
