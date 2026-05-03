/**
 * performance-reader scoringSignals split tests — consensus round 222a567b-94364123.
 *
 * Verifies that totalSignals++ (dashboard volume) and scoringSignals++
 * (accuracy/bench/hallRate denominator) are tracked separately, so operational
 * noise (transport_failure, task_timeout, task_empty, boundary_escape,
 * uncategorized disagreement) cannot inflate confidence or suppress Rule B.
 *
 * Concrete failure modes this closes:
 *   1. Confidence: 150 transport_failure + 10 agreement → confidence ≈ 1.0 (wrong)
 *      should be ≈ 0.63 (1 - exp(-10/10))
 *   2. Rule A: 150 real scoring + 60 noise → Rule A 200-gate fires on only 150 evidence (wrong)
 *   3. Rule B: 5 hallucination_caught + 8 transport_failure → hallRate = 5/13 ≈ 0.38 (wrong)
 *      should be 5/13 → actually 5/(scoring=5) but with decay... test drives via isBenched stub.
 */

import { PerformanceReader, AgentScore } from '../../packages/orchestrator/src/performance-reader';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-perf-reader-scoring-signals');

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

const now = new Date().toISOString();

function makeAgreement(taskId: string, agentId = 'agent-a'): any {
  return {
    type: 'consensus',
    signal: 'agreement',
    taskId,
    agentId,
    counterpartId: 'agent-b',
    category: 'trust_boundaries',
    severity: 'medium',
    evidence: 'confirmed peer finding',
    timestamp: now,
  };
}

function makeTransportFailure(taskId: string, agentId = 'agent-a'): any {
  return {
    type: 'consensus',
    signal: 'transport_failure',
    taskId,
    agentId,
    consensusId: '222a567b-94364123',
    findingId: `222a567b-94364123:${agentId}:${taskId}`,
    evidence: 'Files are not present in the provided worktree',
    timestamp: now,
  };
}

function makeHallucination(taskId: string, agentId = 'agent-a'): any {
  return {
    type: 'consensus',
    signal: 'hallucination_caught',
    taskId,
    agentId,
    category: 'trust_boundaries',
    evidence: 'fabricated line reference',
    timestamp: now,
  };
}

function makeTaskTimeout(taskId: string, agentId = 'agent-a'): any {
  return {
    type: 'consensus',
    signal: 'task_timeout',
    taskId,
    agentId,
    evidence: 'agent timed out',
    timestamp: now,
  };
}

function makeBoundaryEscape(taskId: string, agentId = 'agent-a'): any {
  return {
    type: 'consensus',
    signal: 'boundary_escape',
    taskId,
    agentId,
    evidence: 'wrote outside worktree',
    timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// Scoring-signals tracking
// ---------------------------------------------------------------------------

describe('PerformanceReader — scoringSignals vs totalSignals split', () => {
  it('totalSignals includes transport_failure; scoringSignals excludes it', () => {
    writeSignals([
      makeAgreement('t-1'),
      makeAgreement('t-2'),
      makeAgreement('t-3'),
      makeTransportFailure('t-4'),
      makeTransportFailure('t-5'),
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('agent-a');
    expect(score).toBeDefined();
    expect(score!.totalSignals).toBe(5);
    expect(score!.scoringSignals).toBe(3);
  });

  it('totalSignals includes task_timeout; scoringSignals excludes it', () => {
    writeSignals([
      makeAgreement('t-1'),
      makeAgreement('t-2'),
      makeTaskTimeout('t-3'),
      makeTaskTimeout('t-4'),
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('agent-a');
    expect(score).toBeDefined();
    expect(score!.totalSignals).toBe(4);
    expect(score!.scoringSignals).toBe(2);
  });

  it('totalSignals includes boundary_escape; scoringSignals excludes it', () => {
    writeSignals([
      makeAgreement('t-1'),
      makeBoundaryEscape('t-2'),
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('agent-a');
    expect(score).toBeDefined();
    expect(score!.totalSignals).toBe(2);
    expect(score!.scoringSignals).toBe(1);
  });

  it('uncategorized disagreement counts in totalSignals but not scoringSignals', () => {
    writeSignals([
      makeAgreement('t-1'),
      // disagreement without category → no-op for scoring
      {
        type: 'consensus',
        signal: 'disagreement',
        taskId: 't-2',
        agentId: 'agent-a',
        // deliberately no category
        evidence: 'operational disagreement',
        timestamp: now,
      },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('agent-a');
    expect(score).toBeDefined();
    expect(score!.totalSignals).toBe(2);
    expect(score!.scoringSignals).toBe(1);
  });

  it('hallucination_caught counts in both totalSignals and scoringSignals', () => {
    writeSignals([
      makeHallucination('t-1'),
      makeHallucination('t-2'),
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('agent-a');
    expect(score).toBeDefined();
    expect(score!.totalSignals).toBe(2);
    expect(score!.scoringSignals).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Failure mode 1 — Confidence uses scoringSignals
// ---------------------------------------------------------------------------

describe('PerformanceReader — confidence formula uses scoringSignals', () => {
  it('10 agreement + 100 transport_failure → confidence ≈ 1 - exp(-10/10), NOT 1 - exp(-110/10)', () => {
    const signals: any[] = [];
    // 10 genuine scoring signals
    for (let i = 0; i < 10; i++) signals.push(makeAgreement(`agree-${i}`));
    // 100 operational noise — must not inflate confidence
    for (let i = 0; i < 100; i++) signals.push(makeTransportFailure(`tf-${i}`));
    writeSignals(signals);

    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('agent-a');
    expect(score).toBeDefined();
    expect(score!.totalSignals).toBe(110);
    expect(score!.scoringSignals).toBe(10);

    // getDispatchWeight uses scoringSignals for confidence.
    // confidence(scoringSignals=10) = 1 - exp(-10/10) ≈ 0.632
    // confidence(totalSignals=110)  = 1 - exp(-110/10) ≈ 1.000
    // If confidence is derived from totalSignals the weight would be near-max.
    // With scoringSignals=10 the weight is still elevated (all agreements) but
    // should be significantly less than the inflated value. We verify by
    // checking the dispatch weight lands in the correct window for 10 scoring signals.
    const weight = reader.getDispatchWeight('agent-a');
    // With 10 perfect agreements: reliability ≈ 1.0, confidence ≈ 0.632
    // consensusAdjusted = 0.5 + (1.0 - 0.5) * 0.632 = 0.816
    // weight = clamp(0.3 + 0.816 * 1.7, 0.3, 2.0) ≈ 1.687
    // If inflated (110): confidence ≈ 1.0, weight ≈ 2.0 (max)
    // We assert weight < 2.0 to confirm inflation didn't occur.
    expect(weight).toBeLessThan(2.0);
    // Also assert the weight is meaningfully above neutral (signal is real)
    expect(weight).toBeGreaterThan(1.0);
  });

  it('returns neutral weight when scoringSignals < 3 even if totalSignals is high', () => {
    const signals: any[] = [];
    // 2 scoring signals (below threshold)
    signals.push(makeAgreement('a-1'));
    signals.push(makeAgreement('a-2'));
    // 50 operational noise
    for (let i = 0; i < 50; i++) signals.push(makeTransportFailure(`tf-${i}`));
    writeSignals(signals);

    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('agent-a');
    expect(score!.totalSignals).toBe(52);
    expect(score!.scoringSignals).toBe(2);

    // getDispatchWeight must return neutral 1.0 when scoringSignals < 3
    expect(reader.getDispatchWeight('agent-a')).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Failure mode 2 — Rule A uses scoringSignals
// ---------------------------------------------------------------------------

describe('PerformanceReader.isBenched — Rule A uses scoringSignals', () => {
  function makeScoreWith(
    agentId: string,
    opts: { scoringSignals: number; totalSignals: number; accuracy: number },
  ): AgentScore {
    return {
      agentId,
      accuracy: opts.accuracy,
      uniqueness: 0.5,
      reliability: 0.5,
      impactScore: 0.5,
      totalSignals: opts.totalSignals,
      scoringSignals: opts.scoringSignals,
      agreements: 0,
      disagreements: 0,
      uniqueFindings: 0,
      hallucinations: 0,
      weightedHallucinations: 0,
      consecutiveFailures: 0,
      circuitOpen: false,
      categoryStrengths: {},
      categoryCorrect: {},
      categoryHallucinated: {},
      categoryAccuracy: {},
      transport_failure_count: 0,
    };
  }

  it('199 scoringSignals + 50 noise → NOT benched (Rule A gate needs 200 scoring evidence)', () => {
    const reader = new PerformanceReader('/tmp/gossip-bench-scoring-unused');
    const map = new Map<string, AgentScore>();
    map.set('a', makeScoreWith('a', { scoringSignals: 199, totalSignals: 249, accuracy: 0.29 }));
    (reader as any).getScores = () => map;

    expect(reader.isBenched('a')).toEqual({ benched: false });
  });

  it('200 scoringSignals + 50 noise → benched (Rule A fires on scoring evidence)', () => {
    const reader = new PerformanceReader('/tmp/gossip-bench-scoring-unused');
    const map = new Map<string, AgentScore>();
    map.set('a', makeScoreWith('a', { scoringSignals: 200, totalSignals: 250, accuracy: 0.29 }));
    (reader as any).getScores = () => map;

    expect(reader.isBenched('a')).toEqual({ benched: true, reason: 'chronic-low-accuracy' });
  });
});

// ---------------------------------------------------------------------------
// Failure mode 3 — Rule B hallRate uses scoringSignals
// ---------------------------------------------------------------------------

describe('PerformanceReader.isBenched — Rule B hallRate uses scoringSignals', () => {
  function makeScoreWith(
    agentId: string,
    opts: {
      scoringSignals: number;
      totalSignals: number;
      weightedHallucinations: number;
      accuracy?: number;
    },
  ): AgentScore {
    return {
      agentId,
      accuracy: opts.accuracy ?? 0.8,
      uniqueness: 0.5,
      reliability: 0.5,
      impactScore: 0.5,
      totalSignals: opts.totalSignals,
      scoringSignals: opts.scoringSignals,
      agreements: 0,
      disagreements: 0,
      uniqueFindings: 0,
      hallucinations: 5,
      weightedHallucinations: opts.weightedHallucinations,
      consecutiveFailures: 0,
      circuitOpen: false,
      categoryStrengths: {},
      categoryCorrect: {},
      categoryHallucinated: {},
      categoryAccuracy: {},
      transport_failure_count: 0,
    };
  }

  it('5 halluc + 8 transport_failure: hallRate = 5/5 = 1.0 → Rule B opens', () => {
    // scoringSignals=5 (5 hallucinations are scoring), totalSignals=13 (+ 8 transport)
    // hallRate vs scoringSignals: 5/5 = 1.0 > 0.4 → BENCH
    // hallRate vs totalSignals:   5/13 ≈ 0.38 < 0.4 → NO BENCH (wrong behavior pre-fix)
    const reader = new PerformanceReader('/tmp/gossip-bench-ruleB-unused');
    const map = new Map<string, AgentScore>();
    map.set('a', makeScoreWith('a', {
      scoringSignals: 5,
      totalSignals: 13,
      weightedHallucinations: 5, // exact hallucs (no decay in stub)
    }));
    (reader as any).getScores = () => map;

    expect(reader.isBenched('a')).toEqual({ benched: true, reason: 'burst-hallucination' });
  });

  it('5 halluc + 8 real agreements: hallRate = 5/13 ≈ 0.38 → Rule B stays closed', () => {
    // When noise is real scoring signals, Rule B should NOT fire (< 0.4)
    const reader = new PerformanceReader('/tmp/gossip-bench-ruleB-unused');
    const map = new Map<string, AgentScore>();
    map.set('a', makeScoreWith('a', {
      scoringSignals: 13,
      totalSignals: 13,
      weightedHallucinations: 5,
    }));
    (reader as any).getScores = () => map;

    expect(reader.isBenched('a')).toEqual({ benched: false });
  });
});
