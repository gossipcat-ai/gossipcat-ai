/**
 * performance-reader circuit-breaker exclusion for OPERATIONAL disagreements.
 *
 * Failed dispatches (quota exhaustion, context overflow, model unavailable) are
 * auto-recorded by apps/cli/src/handlers/collect.ts as
 * `{ signal: 'disagreement', signal_class: 'operational' }` with NO `category`.
 * `NEGATIVE_SIGNALS` contains 'disagreement', so before this fix a run of
 * infrastructure failures at an agent's tail opened its circuit breaker and
 * floored dispatch weight — contradicting docs/HANDBOOK.md invariant #14
 * (operational signals are telemetry, never score movement).
 *
 * Verifies:
 *   - trailing operational disagreements never open the breaker;
 *   - real (categorized) negatives still do;
 *   - an operational row does NOT rehabilitate an already-open streak —
 *     it is treated as absent, exactly like `transport_failure`.
 */

import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-perf-reader-operational-disagreement');
const AGENT = 'sonnet-reviewer';

function writeSignals(signals: any[]): void {
  mkdirSync(join(TEST_DIR, '.gossip'), { recursive: true });
  writeFileSync(
    join(TEST_DIR, '.gossip', 'agent-performance.jsonl'),
    signals.map(s => JSON.stringify(s)).join('\n') + '\n',
  );
}

/** Timestamps ascending from oldest → newest, spaced 1s apart. */
function ts(indexFromOldest: number): string {
  return new Date(Date.now() - 60_000 + indexFromOldest * 1000).toISOString();
}

/** A positive performance signal — resets any prior streak. */
function positive(taskId: string, timestamp: string): any {
  return {
    type: 'consensus',
    signal: 'unique_confirmed',
    taskId,
    agentId: AGENT,
    category: 'trust_boundaries',
    severity: 'medium',
    evidence: 'confirmed unique finding',
    timestamp,
  };
}

/** An operational disagreement — a failed dispatch, not a review verdict. */
function operationalDisagreement(taskId: string, timestamp: string): any {
  return {
    type: 'consensus',
    signal: 'disagreement',
    signal_class: 'operational',
    taskId,
    agentId: AGENT,
    evidence: 'Task failed: Context window exceeded',
    timestamp,
  };
}

/** A real, finding-evaluation negative — must feed the breaker. */
function realNegative(
  taskId: string,
  timestamp: string,
  signal: 'disagreement' | 'hallucination_caught',
): any {
  return {
    type: 'consensus',
    signal,
    taskId,
    agentId: AGENT,
    counterpartId: 'gemini-reviewer',
    category: 'trust_boundaries',
    severity: 'medium',
    evidence: 'peer disproved the finding',
    timestamp,
  };
}

function scoreFor(agentId = AGENT) {
  const score = new PerformanceReader(TEST_DIR).getScores().get(agentId);
  expect(score).toBeDefined();
  return score!;
}

function dispatchWeightFor(agentId = AGENT): number {
  return new PerformanceReader(TEST_DIR).getDispatchWeight(agentId);
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('PerformanceReader — operational disagreements and the circuit breaker', () => {
  it('keeps the breaker closed when the tail is operational disagreements after a positive', () => {
    writeSignals([
      // Three positives so scoringSignals >= 3 and getDispatchWeight leaves its
      // "not enough data, neutral" short-circuit — otherwise the weight
      // assertion below would pass vacuously.
      positive('t-0', ts(0)),
      positive('t-1', ts(1)),
      positive('t-2', ts(2)),
      operationalDisagreement('t-3', ts(3)),
      operationalDisagreement('t-4', ts(4)),
      operationalDisagreement('t-5', ts(5)),
      operationalDisagreement('t-6', ts(6)),
    ]);

    const score = scoreFor();
    expect(score.consecutiveFailures).toBe(0);
    expect(score.circuitOpen).toBe(false);
    // The operational rows must not have moved accuracy either — only the
    // three positives are scoring signals.
    expect(score.scoringSignals).toBe(3);
    expect(score.disagreements).toBe(0);
    // Circuit-breaker flooring is what benched the agent; weight must not be
    // pinned to the 0.3 open-circuit floor.
    expect(dispatchWeightFor()).toBeGreaterThan(0.3);
  });

  it('still opens the breaker on three real trailing negatives', () => {
    writeSignals([
      positive('t-0', ts(0)),
      realNegative('t-1', ts(1), 'disagreement'),
      realNegative('t-2', ts(2), 'hallucination_caught'),
      realNegative('t-3', ts(3), 'disagreement'),
    ]);

    const score = scoreFor();
    expect(score.consecutiveFailures).toBe(3);
    expect(score.circuitOpen).toBe(true);
    expect(dispatchWeightFor()).toBe(0.3);
  });

  it('does not let a later operational disagreement rehabilitate an open streak', () => {
    writeSignals([
      positive('t-0', ts(0)),
      realNegative('t-1', ts(1), 'disagreement'),
      realNegative('t-2', ts(2), 'hallucination_caught'),
      realNegative('t-3', ts(3), 'disagreement'),
      // Arrives AFTER the three real negatives: skipped, not a streak-breaker.
      operationalDisagreement('t-4', ts(4)),
    ]);

    const score = scoreFor();
    expect(score.consecutiveFailures).toBe(3);
    expect(score.circuitOpen).toBe(true);
  });

  it('excludes category-less disagreements even without signal_class stamping', () => {
    // Historical rows predate `signal_class`; the category-absence test is the
    // load-bearing predicate and must hold on its own.
    const legacyOperational = (taskId: string, timestamp: string) => ({
      type: 'consensus',
      signal: 'disagreement',
      taskId,
      agentId: AGENT,
      evidence: 'Task failed: quota exhausted',
      timestamp,
    });

    writeSignals([
      positive('t-0', ts(0)),
      legacyOperational('t-1', ts(1)),
      legacyOperational('t-2', ts(2)),
      legacyOperational('t-3', ts(3)),
    ]);

    const score = scoreFor();
    expect(score.consecutiveFailures).toBe(0);
    expect(score.circuitOpen).toBe(false);
  });
});
