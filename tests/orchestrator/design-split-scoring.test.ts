/**
 * Issue #678 — a `design_split` records that two agents reached opposed but
 * DEFENSIBLE conclusions. It must move NO score, for EITHER side.
 *
 * The two-sided part is what makes this different from `operational_lesson`
 * (#668): a split names a `counterpartId`, and `computeScores` indexes task
 * order for the counterpart as well as the subject. So a switch-arm-only
 * exemption would still shift decay weighting for the OTHER agent — the one
 * that was never even the subject of the row. These tests therefore fingerprint
 * both agents, not just the recorded one.
 *
 * Like the #668 suite, they deliberately do not assert on `signal_class`:
 * labelling the row correctly proves nothing about whether the scoring switch
 * counts it. Each test computes a real baseline, appends splits, recomputes, and
 * compares the numbers.
 */

import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import { classifySignal, OPERATIONAL_SIGNAL_NAMES } from '../../packages/orchestrator/src/consensus-types';
import { VALID_CONSENSUS_SIGNALS } from '../../packages/orchestrator/src/performance-writer';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-design-split-scoring');
const SIGNALS_PATH = join(TEST_DIR, '.gossip', 'agent-performance.jsonl');
const AGENT = 'fable-reviewer';
const PEER = 'deepseek-challenger';
const now = new Date().toISOString();

function writeSignals(signals: unknown[]): void {
  mkdirSync(join(TEST_DIR, '.gossip'), { recursive: true });
  writeFileSync(SIGNALS_PATH, signals.map(s => JSON.stringify(s)).join('\n') + '\n');
}

function agreement(taskId: string, agentId: string): Record<string, unknown> {
  return {
    type: 'consensus', signal: 'agreement', taskId, agentId,
    counterpartId: 'gemini-reviewer', category: 'trust_boundaries', severity: 'medium',
    findingId: `b81956b2-e0fa4ea4:${agentId}:f1`, evidence: 'confirmed peer finding', timestamp: now,
  };
}

function hallucination(taskId: string, agentId: string): Record<string, unknown> {
  return {
    type: 'consensus', signal: 'hallucination_caught', taskId, agentId,
    category: 'trust_boundaries', severity: 'high', outcome: 'fabricated_citation',
    findingId: `b81956b2-e0fa4ea4:${agentId}:f9`, evidence: 'cited a line that does not exist', timestamp: now,
  };
}

/** The #666-round case from the issue, in row form. */
function designSplit(slug: string, opts: { category?: string } = {}): Record<string, unknown> {
  return {
    type: 'consensus', signal: 'design_split', taskId: `manual-${slug}`, agentId: AGENT,
    counterpartId: PEER, signal_class: 'operational',
    findingId: `session:2026-07-27-c0ffee01:${slug}`, source: 'manual',
    ...(opts.category ? { category: opts.category } : {}),
    evidence:
      'fable: inject per-agent failure-pattern content into Phase-2 cross-review. ' +
      'deepseek: the block must be agent-independent or claimant and verifier correlate.',
    timestamp: now,
  };
}

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

// `reliability` folds in a wall-clock recency term — freeze Date.now() so any
// delta between `before` and `after` is attributable to the appended rows.
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

describe('design_split taxonomy registration', () => {
  it('classifies as operational, not performance', () => {
    expect(OPERATIONAL_SIGNAL_NAMES.has('design_split')).toBe(true);
    expect(classifySignal('design_split')).toBe('operational');
  });

  it('is accepted by validateSignal (else every emit is silently dropped)', () => {
    // The PR #329 failure mode: classified but not on the writer allowlist.
    expect(VALID_CONSENSUS_SIGNALS.has('design_split')).toBe(true);
  });
});

describe('design_split debits neither side', () => {
  it('leaves the recorded agent\'s score bit-identical', () => {
    const baseSignals = [agreement('t1', AGENT), agreement('t2', AGENT), hallucination('t3', AGENT)];

    writeSignals(baseSignals);
    const before = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);

    writeSignals([
      ...baseSignals,
      designSplit('phase2-conditioning-vs-independence'),
      designSplit('another-open-tradeoff'),
    ]);
    const after = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);

    expect(after).toEqual(before);
    // Sanity: a real, non-degenerate baseline — otherwise equality is trivial.
    expect(before.accuracy).toBeGreaterThan(0);
    expect(before.accuracy).toBeLessThan(1);
    expect(before.scoringSignals).toBe(3);
  });

  it('leaves the COUNTERPART\'s score bit-identical too', () => {
    // The issue's actual complaint: `deepseek-challenger: +2 / -1`. The peer is
    // named on the row, so a no-op switch arm alone would still index its task
    // order and re-weight its decay.
    const baseSignals = [agreement('p1', PEER), agreement('p2', PEER), hallucination('p3', PEER)];

    writeSignals(baseSignals);
    const before = scoreFingerprint(new PerformanceReader(TEST_DIR), PEER);

    writeSignals([...baseSignals, designSplit('opposed-but-defensible')]);
    const after = scoreFingerprint(new PerformanceReader(TEST_DIR), PEER);

    expect(after).toEqual(before);
    expect(before.scoringSignals).toBe(3);
  });

  it('is excluded even when it carries a category', () => {
    // `category` is optional on a split but permitted. A categorized row must
    // not sneak into the accuracy arm the way a categorized operational
    // `disagreement` would if its signal_class were ignored.
    const baseSignals = [agreement('t1', AGENT), hallucination('t2', AGENT)];

    writeSignals(baseSignals);
    const before = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);

    writeSignals([...baseSignals, designSplit('categorized', { category: 'trust_boundaries' })]);
    expect(scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT)).toEqual(before);
  });

  it('cannot manufacture a score for an agent that has only splits', () => {
    writeSignals([designSplit('only-split')]);
    const scores = new PerformanceReader(TEST_DIR).getScores();
    expect(scores.get(AGENT)).toBeUndefined();
    expect(scores.get(PEER)).toBeUndefined();
  });
});

describe('design_split and the circuit-breaker streak', () => {
  it('cannot open the breaker no matter how many are recorded', () => {
    writeSignals(Array.from({ length: 12 }, (_, i) => designSplit(`split-${i}`)));
    expect(new PerformanceReader(TEST_DIR).getScores().get(AGENT)).toBeUndefined();
  });

  it('does not RESET a real hallucination streak either (pure no-op, not a positive)', () => {
    // The inverse failure: `design_split` is not in NEGATIVE_SIGNALS, so a row
    // that reached the streak builder would count as a streak-BREAKER and
    // rehabilitate an agent sitting on three consecutive hallucinations.
    const streak = [hallucination('h1', AGENT), hallucination('h2', AGENT), hallucination('h3', AGENT)];

    writeSignals(streak);
    const before = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);
    expect(before.circuitOpen).toBe(true);

    writeSignals([...streak, designSplit('appended-after-streak')]);
    const after = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);

    expect(after).toEqual(before);
    expect(after.circuitOpen).toBe(true);
  });
});

describe('resolution is a later scoring signal on the same finding_id', () => {
  it('a follow-up disagreement on the split\'s finding_id DOES score', () => {
    // Documents the resolution contract: the split itself never scores, but the
    // orchestrator resolving it later against the SAME finding_id does. If this
    // ever stops scoring, resolution has become unrecordable and the taxonomy
    // has silently turned into "disagreements are free".
    const splitFindingId = 'session:2026-07-27-c0ffee01:resolved-later';
    const split = { ...designSplit('resolved-later'), findingId: splitFindingId };
    const resolution = {
      type: 'consensus', signal: 'disagreement', taskId: 'manual-resolution', agentId: AGENT,
      counterpartId: PEER, category: 'trust_boundaries', severity: 'medium',
      signal_class: 'performance', findingId: splitFindingId, source: 'manual',
      evidence: 'the independence argument was shown correct by the correlation measurement',
      timestamp: now,
    };

    writeSignals([agreement('t1', AGENT), split]);
    const unresolved = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);

    writeSignals([agreement('t1', AGENT), split, resolution]);
    const resolved = scoreFingerprint(new PerformanceReader(TEST_DIR), AGENT);

    expect(resolved.disagreements).toBe(unresolved.disagreements + 1);
    expect(resolved.accuracy).toBeLessThan(unresolved.accuracy);
  });
});
