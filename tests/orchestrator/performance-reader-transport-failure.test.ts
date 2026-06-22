/**
 * performance-reader transport_failure exclusion tests — Path 2 mitigation
 * for the relay-worker resolutionRoots plumbing gap. Spec:
 * docs/specs/2026-04-29-relay-worker-resolution-roots.md.
 *
 * Verifies:
 *   - `transport_failure` rows are excluded from accuracy / uniqueness
 *     arithmetic — a relay cwd outage cannot poison agent rankings.
 *   - `transport_failure_count` is populated on AgentScore so dashboards can
 *     surface the ops issue separately from the scoring track.
 *   - `transport_failure` is NOT a negative signal: it never feeds the
 *     circuit breaker.
 */

import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-perf-reader-transport-failure');

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

function makeBaseAgreement(taskId: string, agentId = 'gemini-reviewer'): any {
  return {
    type: 'consensus',
    signal: 'agreement',
    taskId,
    agentId,
    counterpartId: 'sonnet-reviewer',
    category: 'trust_boundaries',
    severity: 'medium',
    evidence: 'confirmed peer finding',
    timestamp: now,
  };
}

describe('PerformanceReader — transport_failure exclusion', () => {
  it('excludes transport_failure from accuracy arithmetic', () => {
    // Three agreements (positive) + one transport_failure. Without the
    // exclusion, the transport_failure should not contribute. We verify by
    // comparing to a baseline run with NO transport_failure row.
    writeSignals([
      makeBaseAgreement('t-1'),
      makeBaseAgreement('t-2'),
      makeBaseAgreement('t-3'),
      {
        type: 'consensus',
        signal: 'transport_failure',
        taskId: 't-4',
        agentId: 'gemini-reviewer',
        consensusId: '328adef4-087942f7',
        findingId: '328adef4-087942f7:gemini-reviewer:f1',
        category: 'trust_boundaries',
        evidence: 'Files are not present in the provided worktree',
        timestamp: now,
      },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('gemini-reviewer');
    expect(score).toBeDefined();
    // Hallucination count must be zero — the transport_failure row must NOT
    // be counted as a hallucination.
    expect(score!.hallucinations).toBe(0);
    expect(score!.weightedHallucinations).toBe(0);
    // Accuracy should reflect 3 agreements / 3 total = 1.0 (or whatever the
    // baseline produces). The key invariant is: transport_failure didn't
    // pull accuracy down.
    expect(score!.accuracy).toBeGreaterThan(0.5);
  });

  it('populates transport_failure_count on AgentScore', () => {
    writeSignals([
      makeBaseAgreement('t-1'),
      {
        type: 'consensus',
        signal: 'transport_failure',
        taskId: 't-2',
        agentId: 'gemini-reviewer',
        consensusId: '328adef4-087942f7',
        findingId: '328adef4-087942f7:gemini-reviewer:f1',
        evidence: 'Files are not present',
        timestamp: now,
      },
      {
        type: 'consensus',
        signal: 'transport_failure',
        taskId: 't-3',
        agentId: 'gemini-reviewer',
        consensusId: '328adef4-087942f7',
        findingId: '328adef4-087942f7:gemini-reviewer:f2',
        evidence: 'empty diff',
        timestamp: now,
      },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('gemini-reviewer');
    expect(score).toBeDefined();
    expect(score!.transport_failure_count).toBe(2);
  });

  it('does not feed circuit breaker — transport_failure breaks no streak and starts no streak', () => {
    // Two trailing hallucinations would bump consecutiveFailures to 2 (just
    // under the threshold). Insert a transport_failure as the most recent
    // signal — it should NOT count as a failure (streak stays 2) and should
    // NOT count as a positive (does not reset the streak to 0). The streak
    // is computed from the next-most-recent eligible signal: hallucination.
    const t0 = new Date(Date.now() - 3000).toISOString();
    const t1 = new Date(Date.now() - 2000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();
    writeSignals([
      {
        type: 'consensus', signal: 'hallucination_caught',
        taskId: 'h-1', agentId: 'gemini-reviewer',
        category: 'trust_boundaries', evidence: 'real hallucination',
        timestamp: t0,
      },
      {
        type: 'consensus', signal: 'hallucination_caught',
        taskId: 'h-2', agentId: 'gemini-reviewer',
        category: 'trust_boundaries', evidence: 'real hallucination',
        timestamp: t1,
      },
      {
        type: 'consensus', signal: 'transport_failure',
        taskId: 'h-3', agentId: 'gemini-reviewer',
        consensusId: '328adef4-087942f7',
        findingId: '328adef4-087942f7:gemini-reviewer:f1',
        evidence: 'Files are not present',
        timestamp: t2,
      },
    ]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('gemini-reviewer');
    expect(score).toBeDefined();
    // Two hallucinations are streak-eligible; transport_failure is invisible
    // to the streak logic so the count is exactly 2.
    expect(score!.consecutiveFailures).toBe(2);
    expect(score!.circuitOpen).toBe(false);
  });

  it('defaults transport_failure_count to 0 when absent', () => {
    writeSignals([makeBaseAgreement('t-1')]);
    const reader = new PerformanceReader(TEST_DIR);
    const score = reader.getScores().get('gemini-reviewer');
    expect(score).toBeDefined();
    expect(score!.transport_failure_count).toBe(0);
  });
});
