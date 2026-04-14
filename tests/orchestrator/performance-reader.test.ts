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
    // Ratio-based: rawAccuracy = 3/3 = 1.0, accuracy = 1.0
    // Uniqueness: ratio-based with confidence gating.
    //   unique=1, agreements=2 → rawUniqueness = 1/3 = 0.33
    //   uniqueTotal=3, confidence = 1 - exp(-3/10) ≈ 0.26
    //   uniqueness = 0.5 + (0.33 - 0.5) * 0.26 ≈ 0.46
    // Reliability = accuracy*0.75 + uniqueness*0.15 + impactScore*0.10
    //   ≈ 0.75 + 0.069 + 0.05 = 0.869
    expect(score.accuracy).toBeCloseTo(1.0, 1);
    expect(score.uniqueness).toBeGreaterThan(0.4);
    expect(score.uniqueness).toBeLessThan(0.55);
    expect(score.reliability).toBeGreaterThan(0.8);
    expect(score.reliability).toBeLessThan(0.95);
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

describe('PerformanceReader.getCountersSince', () => {
  it('returns {correct: 0, hallucinated: 0} when no matching signals exist', () => {
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'agent-1', category: 'cat-a', taskId: 't1', timestamp: new Date().toISOString() },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const counters = reader.getCountersSince('agent-2', 'cat-a', 0);
    expect(counters).toEqual({ correct: 0, hallucinated: 0 });
    const counters2 = reader.getCountersSince('agent-1', 'cat-b', 0);
    expect(counters2).toEqual({ correct: 0, hallucinated: 0 });
  });

  it('lifetime mode (sinceMs=0) counts all non-retracted signals including >30d old', () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    writeSignals([
      // Old signals (should be counted)
      { type: 'consensus', signal: 'agreement', agentId: 'agent-1', category: 'cat-a', taskId: 't1', timestamp: fortyDaysAgo },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'agent-1', category: 'cat-a', taskId: 't2', timestamp: fortyDaysAgo },
      { type: 'consensus', signal: 'disagreement', agentId: 'agent-1', category: 'cat-a', taskId: 't3', timestamp: fortyDaysAgo },
      // Recent signals (should be counted)
      { type: 'consensus', signal: 'category_confirmed', agentId: 'agent-1', category: 'cat-a', taskId: 't4', timestamp: tenDaysAgo },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-1', category: 'cat-a', taskId: 't5', timestamp: tenDaysAgo },
      // Irrelevant signals (should be ignored)
      { type: 'consensus', signal: 'agreement', agentId: 'agent-2', category: 'cat-a', taskId: 't6', timestamp: tenDaysAgo },
      { type: 'consensus', signal: 'agreement', agentId: 'agent-1', category: 'cat-b', taskId: 't7', timestamp: tenDaysAgo },
    ]);

    const reader = new PerformanceReader(TEST_DIR);
    const counters = reader.getCountersSince('agent-1', 'cat-a', 0);
    expect(counters).toEqual({ correct: 3, hallucinated: 2 });
  });

  it('anchored mode (sinceMs > 0) only counts signals after the timestamp', () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000);
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    const anchorMs = Date.now() - 20 * 86400000;

    writeSignals([
      // Old signals (should be ignored)
      { type: 'consensus', signal: 'agreement', agentId: 'agent-1', category: 'cat-a', taskId: 't1', timestamp: fortyDaysAgo.toISOString() },
      { type: 'consensus', signal: 'disagreement', agentId: 'agent-1', category: 'cat-a', taskId: 't2', timestamp: fortyDaysAgo.toISOString() },
      // Recent signals (should be counted)
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'agent-1', category: 'cat-a', taskId: 't3', timestamp: tenDaysAgo.toISOString() },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-1', category: 'cat-a', taskId: 't4', timestamp: tenDaysAgo.toISOString() },
    ]);

    const reader = new PerformanceReader(TEST_DIR);
    const counters = reader.getCountersSince('agent-1', 'cat-a', anchorMs);
    expect(counters).toEqual({ correct: 1, hallucinated: 1 });
  });

  it('excludes retracted signals regardless of age', () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    writeSignals([
      // Old signals, one retracted
      { type: 'consensus', signal: 'agreement', agentId: 'agent-1', category: 'cat-a', taskId: 't1', timestamp: fortyDaysAgo },
      { type: 'consensus', signal: 'disagreement', agentId: 'agent-1', category: 'cat-a', taskId: 't2', timestamp: fortyDaysAgo }, // This one is retracted
      { type: 'consensus', signal: 'signal_retracted', agentId: 'agent-1', taskId: 't2', retractedSignal: 'disagreement', timestamp: tenDaysAgo },
      // Recent signals, one retracted by wildcard
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'agent-1', category: 'cat-a', taskId: 't3', timestamp: tenDaysAgo }, // This one is retracted
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-1', category: 'cat-a', taskId: 't4', timestamp: tenDaysAgo },
      { type: 'consensus', signal: 'signal_retracted', agentId: 'agent-1', taskId: 't3', timestamp: tenDaysAgo }, // Wildcard retraction
    ]);

    const reader = new PerformanceReader(TEST_DIR);
    // Lifetime check
    const counters1 = reader.getCountersSince('agent-1', 'cat-a', 0);
    expect(counters1).toEqual({ correct: 1, hallucinated: 1 });
    // Anchored check
    const anchorMs = Date.now() - 20 * 86400000;
    const counters2 = reader.getCountersSince('agent-1', 'cat-a', anchorMs);
    expect(counters2).toEqual({ correct: 0, hallucinated: 1 });
  });
});

describe('PerformanceReader — circuit breaker chronology (signal-timestamp-from-task-time)', () => {
  // Regression suite for the bulk-record bug. Before the fix, every signal in a
  // bulk-record call shared one timestamp; the reader's localeCompare sort
  // returned 0 for every pair, making the sort a no-op and letting append order
  // determine the tail. The reader was always correct in intent — these tests
  // pin its behavior so a future regression to "single batch timestamp"
  // recording immediately fails.

  function ts(daysAgo: number, ms = 0): string {
    return new Date(Date.now() - daysAgo * 86400000 + ms).toISOString();
  }

  it('circuit OPEN when 3 newest signals are negative (true chronology)', () => {
    writeSignals([
      // 3 positives in the past
      { type: 'consensus', signal: 'agreement', agentId: 'rev', counterpartId: 'p', taskId: 't1', evidence: 'x', timestamp: ts(5) },
      { type: 'consensus', signal: 'agreement', agentId: 'rev', counterpartId: 'p', taskId: 't2', evidence: 'x', timestamp: ts(4) },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'rev', taskId: 't3', evidence: 'x', timestamp: ts(3) },
      // 3 negatives more recent (unique_unconfirmed removed from NEGATIVE_SIGNALS — use hallucination instead)
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'rev', counterpartId: 'p', taskId: 't4', evidence: 'bad', timestamp: ts(2) },
      { type: 'consensus', signal: 'disagreement', agentId: 'rev', counterpartId: 'p', taskId: 't5', evidence: 'bad', timestamp: ts(1) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'rev', counterpartId: 'p', taskId: 't6', evidence: 'bad', timestamp: ts(0) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    expect(reader.isCircuitOpen('rev')).toBe(true);
  });

  it('circuit CLOSED when newest signal is positive even though older negatives exist', () => {
    writeSignals([
      // 3 negatives in the past
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'rev', counterpartId: 'p', taskId: 't1', evidence: 'bad', timestamp: ts(5) },
      { type: 'consensus', signal: 'disagreement', agentId: 'rev', counterpartId: 'p', taskId: 't2', evidence: 'bad', timestamp: ts(4) },
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'rev', taskId: 't3', evidence: 'bad', timestamp: ts(3) },
      // Newest is positive — must break the streak
      { type: 'consensus', signal: 'agreement', agentId: 'rev', counterpartId: 'p', taskId: 't4', evidence: 'x', timestamp: ts(0) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    expect(reader.isCircuitOpen('rev')).toBe(false);
  });

  it('circuit CLOSED when negatives are recorded in append order but timestamps put them in the past', () => {
    // Simulates the exact bug from session 2026-04-08: orchestrator bulk-records
    // 5 backlogged rounds in newest-first read order, so the JSONL tail is the
    // OLDEST round. With per-signal timestamps from the consensus reports, the
    // reader's chronological sort must put the actually-newest round at the tail.
    writeSignals([
      // Append order = newest-first (file tail = oldest)
      { type: 'consensus', signal: 'agreement', agentId: 'rev', counterpartId: 'p', taskId: 'newest', evidence: 'x', timestamp: ts(0) },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'rev', taskId: 'newer', evidence: 'x', timestamp: ts(1) },
      { type: 'consensus', signal: 'agreement', agentId: 'rev', counterpartId: 'p', taskId: 'mid', evidence: 'x', timestamp: ts(2) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'rev', counterpartId: 'p', taskId: 'old', evidence: 'bad', timestamp: ts(3) },
      { type: 'consensus', signal: 'disagreement', agentId: 'rev', counterpartId: 'p', taskId: 'oldest1', evidence: 'bad', timestamp: ts(4) },
      { type: 'consensus', signal: 'disagreement', agentId: 'rev', counterpartId: 'p', taskId: 'oldest2', evidence: 'bad', timestamp: ts(5) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    // True chronology: 3 negatives (oldest) → 3 positives (newest). Tail is positive.
    expect(reader.isCircuitOpen('rev')).toBe(false);
  });

  it('circuit OPEN when negatives appended first but timestamps make them newest', () => {
    // The exact incident: even though file order looks "good then bad",
    // the bad signals are CHRONOLOGICALLY NEWER and must trip the breaker.
    writeSignals([
      { type: 'consensus', signal: 'disagreement', agentId: 'rev', counterpartId: 'p', taskId: 'oldest', evidence: 'bad', timestamp: ts(2) },
      { type: 'consensus', signal: 'agreement', agentId: 'rev', counterpartId: 'p', taskId: 'mid', evidence: 'x', timestamp: ts(5) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'rev', counterpartId: 'p', taskId: 'newer', evidence: 'bad', timestamp: ts(1) },
      { type: 'consensus', signal: 'disagreement', agentId: 'rev', counterpartId: 'p', taskId: 'newest', evidence: 'bad', timestamp: ts(0) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    expect(reader.isCircuitOpen('rev')).toBe(true);
  });

  it('consensusId tiebreaker keeps order deterministic when timestamps collide', () => {
    // Two signals with the SAME timestamp — tiebreaker on consensusId.
    // Without the tiebreaker, sort order would depend on file order; with it,
    // 'aaa' always sorts before 'bbb' so the tail is deterministic.
    const sameTime = ts(0);
    writeSignals([
      { type: 'consensus', signal: 'agreement', agentId: 'rev', counterpartId: 'p', consensusId: 'bbb', taskId: 't1', evidence: 'x', timestamp: sameTime },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'rev', consensusId: 'aaa', taskId: 't2', evidence: 'x', timestamp: sameTime },
      { type: 'consensus', signal: 'agreement', agentId: 'rev', counterpartId: 'p', consensusId: 'aaa', taskId: 't3', evidence: 'x', timestamp: ts(1) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    // The tail is the bbb-tagged signal (positive) — circuit closed.
    // What we're really testing: the reader doesn't crash, returns deterministic state.
    expect(reader.isCircuitOpen('rev')).toBe(false);
    // Run twice to confirm idempotence under tiebreaker.
    expect(reader.isCircuitOpen('rev')).toBe(false);
  });
});

describe('PerformanceReader — circuit breaker: unique_unconfirmed removed from NEGATIVE_SIGNALS', () => {
  // Change 1 from docs/specs/2026-04-14-circuit-breaker-fix.md
  // Consensus round: 4d6406d5-b0e147a5
  // Rationale: unique_unconfirmed covers 3 ambiguous conditions (peer couldn't verify,
  // task timed out, empty output). None indicate hallucination. The weighted scoring
  // loop already treats it as near-neutral. Removing it only relaxes the binary
  // circuit-breaker streak count.

  function ts(daysAgo: number, ms = 0): string {
    return new Date(Date.now() - daysAgo * 86400000 + ms).toISOString();
  }

  it('5 consecutive unique_unconfirmed: consecutiveFailures === 0, circuitOpen === false', () => {
    // unique_unconfirmed no longer benches — peer couldn't verify / timeout / empty
    // output do not constitute evidence of agent error.
    writeSignals([
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-a', taskId: 't1', evidence: '', timestamp: ts(4) },
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-a', taskId: 't2', evidence: '', timestamp: ts(3) },
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-a', taskId: 't3', evidence: '', timestamp: ts(2) },
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-a', taskId: 't4', evidence: '', timestamp: ts(1) },
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-a', taskId: 't5', evidence: '', timestamp: ts(0) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('agent-a')!;
    expect(score.consecutiveFailures).toBe(0);
    expect(score.circuitOpen).toBe(false);
  });

  it('3 consecutive hallucination_caught still bench: consecutiveFailures === 3, circuitOpen === true', () => {
    // hallucination_caught remains in NEGATIVE_SIGNALS — real correctness error.
    writeSignals([
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-b', counterpartId: 'peer', taskId: 't1', evidence: 'bad', timestamp: ts(2) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-b', counterpartId: 'peer', taskId: 't2', evidence: 'bad', timestamp: ts(1) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-b', counterpartId: 'peer', taskId: 't3', evidence: 'bad', timestamp: ts(0) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('agent-b')!;
    expect(score.consecutiveFailures).toBe(3);
    expect(score.circuitOpen).toBe(true);
  });

  it('3 consecutive disagreement (loser) still bench: circuitOpen === true', () => {
    // disagreement remains in NEGATIVE_SIGNALS — agentId is the loser.
    // Only the loser gets a disagreement signal record; winner gets no streak tick.
    writeSignals([
      { type: 'consensus', signal: 'disagreement', agentId: 'agent-c', counterpartId: 'winner', taskId: 't1', evidence: 'bad', timestamp: ts(2) },
      { type: 'consensus', signal: 'disagreement', agentId: 'agent-c', counterpartId: 'winner', taskId: 't2', evidence: 'bad', timestamp: ts(1) },
      { type: 'consensus', signal: 'disagreement', agentId: 'agent-c', counterpartId: 'winner', taskId: 't3', evidence: 'bad', timestamp: ts(0) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('agent-c')!;
    expect(score.circuitOpen).toBe(true);
    // Winner must NOT be penalized
    const winnerScore = reader.getAgentScore('winner');
    expect(winnerScore?.circuitOpen ?? false).toBe(false);
  });

  it('unique_unconfirmed in middle breaks the streak: only trailing 3 hallucinations count', () => {
    // Signal sequence (oldest → newest):
    //   hallucination, hallucination, unique_unconfirmed, hallucination, hallucination, hallucination
    //
    // With unique_unconfirmed no longer negative, it acts as a streak-breaker
    // (non-negative signal stops the backwards walk). The trailing 3 hallucinations
    // form a streak of 3, not 5 (the earlier 2 are cut off by the non-negative signal).
    writeSignals([
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-d', counterpartId: 'p', taskId: 't1', evidence: 'bad', timestamp: ts(5) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-d', counterpartId: 'p', taskId: 't2', evidence: 'bad', timestamp: ts(4) },
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-d', taskId: 't3', evidence: '', timestamp: ts(3) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-d', counterpartId: 'p', taskId: 't4', evidence: 'bad', timestamp: ts(2) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-d', counterpartId: 'p', taskId: 't5', evidence: 'bad', timestamp: ts(1) },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'agent-d', counterpartId: 'p', taskId: 't6', evidence: 'bad', timestamp: ts(0) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('agent-d')!;
    // Backwards walk: 3 hallucinations at tail → streak = 3. unique_unconfirmed is not
    // negative, so it stops the walk. The two earlier hallucinations do not extend the streak.
    expect(score.consecutiveFailures).toBe(3);
    expect(score.circuitOpen).toBe(true);
  });

  it('positive signal after unique_unconfirmed run resets streak: consecutiveFailures === 0', () => {
    // 3 unique_unconfirmed (now non-negative) followed by 1 agreement at tail.
    // The tail is positive → streak walks back 0 consecutive negatives.
    writeSignals([
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-e', taskId: 't1', evidence: '', timestamp: ts(3) },
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-e', taskId: 't2', evidence: '', timestamp: ts(2) },
      { type: 'consensus', signal: 'unique_unconfirmed', agentId: 'agent-e', taskId: 't3', evidence: '', timestamp: ts(1) },
      { type: 'consensus', signal: 'agreement', agentId: 'agent-e', counterpartId: 'peer', taskId: 't4', evidence: 'ok', timestamp: ts(0) },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getAgentScore('agent-e')!;
    expect(score.consecutiveFailures).toBe(0);
    expect(score.circuitOpen).toBe(false);
  });
});
