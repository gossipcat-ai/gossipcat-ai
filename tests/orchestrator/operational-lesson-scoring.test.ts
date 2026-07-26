/**
 * Issue #668 §2 — an operator-authored `operational_lesson` must NOT move any
 * agent score. "Score preconditions, not decisions" (HANDBOOK invariant #14):
 * recording your own process mistake makes a lesson retrievable, nothing more.
 *
 * These tests deliberately do NOT assert on `signal_class`. Asserting the class
 * field would only prove we labelled the row correctly; it would still pass if
 * the scoring switch quietly started counting it. Instead each test computes a
 * real baseline score, appends operational_lesson rows, recomputes, and
 * compares the numbers.
 */

import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { classifySignal, OPERATIONAL_SIGNAL_NAMES } from '../../packages/orchestrator/src/consensus-types';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-operational-lesson-scoring');
const SIGNALS_PATH = join(TEST_DIR, '.gossip', 'agent-performance.jsonl');
const AGENT = 'sonnet-reviewer';
const now = new Date().toISOString();

function writeSignals(signals: unknown[]): void {
  mkdirSync(join(TEST_DIR, '.gossip'), { recursive: true });
  writeFileSync(SIGNALS_PATH, signals.map(s => JSON.stringify(s)).join('\n') + '\n');
}

function agreement(taskId: string): Record<string, unknown> {
  return {
    type: 'consensus', signal: 'agreement', taskId, agentId: AGENT,
    counterpartId: 'gemini-reviewer', category: 'trust_boundaries', severity: 'medium',
    findingId: `b81956b2-e0fa4ea4:${AGENT}:f1`, evidence: 'confirmed peer finding', timestamp: now,
  };
}

function hallucination(taskId: string): Record<string, unknown> {
  return {
    type: 'consensus', signal: 'hallucination_caught', taskId, agentId: AGENT,
    category: 'trust_boundaries', severity: 'high', outcome: 'fabricated_citation',
    findingId: `b81956b2-e0fa4ea4:${AGENT}:f9`, evidence: 'cited a line that does not exist', timestamp: now,
  };
}

function operationalLesson(slug: string): Record<string, unknown> {
  return {
    type: 'consensus', signal: 'operational_lesson', taskId: `manual-${slug}`, agentId: AGENT,
    signal_class: 'operational', findingId: `session:2026-07-26-a38286c2:${slug}`,
    source: 'manual', evidence: 'switched the root git branch under live reviewers', timestamp: now,
  };
}

/** Every field of AgentScore that any downstream consumer treats as a score. */
function scoreFingerprint(reader: PerformanceReader, agentId: string) {
  const s = reader.getScores().get(agentId)!;
  return {
    accuracy: s.accuracy,
    uniqueness: s.uniqueness,
    reliability: s.reliability,
    impactScore: s.impactScore,
    scoringSignals: s.scoringSignals,
    agreements: s.agreements,
    disagreements: s.disagreements,
    hallucinations: s.hallucinations,
    weightedHallucinations: s.weightedHallucinations,
    uniqueFindings: s.uniqueFindings,
    consecutiveFailures: s.consecutiveFailures,
    circuitOpen: s.circuitOpen,
  };
}

// `reliability` folds in a wall-clock recency term, so two readers constructed
// a few milliseconds apart differ in the 9th decimal even on identical input.
// Freeze Date.now() to the timestamp the fixtures were built with, so any
// difference between `before` and `after` is attributable to the signal alone.
const FIXED_NOW = new Date(now).getTime();
let nowSpy: jest.SpyInstance<number, []>;

beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  nowSpy.mockRestore();
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('operational_lesson is excluded from accuracy scoring', () => {
  it('classifies as operational, not performance', () => {
    expect(OPERATIONAL_SIGNAL_NAMES.has('operational_lesson')).toBe(true);
    expect(classifySignal('operational_lesson')).toBe('operational');
  });

  it('does not change a computed accuracy score', () => {
    const baseSignals = [agreement('t1'), agreement('t2'), hallucination('t3')];

    writeSignals(baseSignals);
    const before = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);

    writeSignals([
      ...baseSignals,
      operationalLesson('branch-switched-under-reviewers'),
      operationalLesson('relay-window-expired'),
      operationalLesson('probe-artifact-as-premise'),
    ]);
    const after = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);

    expect(after).toEqual(before);
    // Sanity: the baseline is a real, non-degenerate score — otherwise the
    // equality above could be trivially true for an all-zero fingerprint.
    expect(before.accuracy).toBeGreaterThan(0);
    expect(before.accuracy).toBeLessThan(1);
    expect(before.scoringSignals).toBe(3);
  });

  it('cannot manufacture a score for an agent that has only operational lessons', () => {
    writeSignals([operationalLesson('only-lesson')]);
    // No score entry at all — the row is audit-log/lesson-card material, and is
    // invisible to the scoring reader. (The dashboard reads the jsonl directly.)
    expect(new PerformanceReader(TEST_DIR).getScores().get(AGENT)).toBeUndefined();
  });

  it('cannot open the circuit breaker no matter how many are recorded', () => {
    writeSignals(Array.from({ length: 12 }, (_, i) => operationalLesson(`lesson-${i}`)));
    expect(new PerformanceReader(TEST_DIR).getScores().get(AGENT)).toBeUndefined();
  });

  it('does not reset a real hallucination streak either (pure no-op, not a positive)', () => {
    const streak = [hallucination('h1'), hallucination('h2'), hallucination('h3')];

    writeSignals(streak);
    const before = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);
    expect(before.circuitOpen).toBe(true);

    writeSignals([...streak, operationalLesson('appended-after-streak')]);
    const after = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);
    expect(after).toEqual(before);
  });
});
