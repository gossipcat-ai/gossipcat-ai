/**
 * Issue #678 ledger item — the FOURTH operational-class exclusion surface.
 *
 * Three surfaces already excluded `signal_class: 'operational'` rows from
 * accuracy math (PRs #690/#692/#695): the accuracy arm, the circuit-breaker
 * streak, and `rebuildAggregateIndex`. The incremental sidecar fold-in
 * (`deriveAggregateKey` in performance-writer.ts) did not — it gated only on
 * `classifyForAggregate(signal)`, which keys off the signal NAME.
 *
 * That leaves one row shape divergent: a `disagreement` (name → 'hallucinated')
 * WITH a category (sidecar partitions by category) AND
 * `signal_class: 'operational'`. That is not hypothetical — it is exactly what a
 * failed dispatch produces once synthesis stamps the class. The write path
 * counted it as a hallucination; a later rebuild dropped it. Two readers of the
 * same jsonl then disagreed, and which answer you got depended on whether the
 * sidecar happened to be stale.
 *
 * These tests pin CONVERGENCE — incremental fold-in must equal a from-scratch
 * rebuild — rather than asserting a particular bucket shape, so they keep
 * holding if the bucket layout is ever changed.
 */

import { PerformanceWriter } from '../../packages/orchestrator/src/performance-writer';
import {
  rebuildAggregateIndex,
  readAggregateIndex,
} from '../../packages/orchestrator/src/signal-aggregate-index';
import type { PerformanceSignal } from '../../packages/orchestrator/src/consensus-types';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(__dirname, '..', '..', '.test-aggregate-key-operational');
const SIGNALS_PATH = join(TEST_DIR, '.gossip', 'agent-performance.jsonl');
const AGENT = 'sonnet-reviewer';
const CATEGORY = 'trust_boundaries';
const now = new Date().toISOString();

function writeJsonl(signals: PerformanceSignal[]): void {
  mkdirSync(join(TEST_DIR, '.gossip'), { recursive: true });
  writeFileSync(SIGNALS_PATH, signals.map(s => JSON.stringify(s)).join('\n') + '\n');
}

/** A real verdict — must be counted by both paths. */
function scoringAgreement(): PerformanceSignal {
  return {
    type: 'consensus', signal: 'agreement', taskId: 'real-1', agentId: AGENT,
    counterpartId: 'gemini-reviewer', category: CATEGORY, signal_class: 'performance',
    findingId: `b81956b2-e0fa4ea4:${AGENT}:f1`, source: 'manual',
    evidence: 'confirmed peer finding', timestamp: now,
  } as PerformanceSignal;
}

/**
 * The divergent shape: a scoring signal NAME, a category, and an operational
 * class stamp. Auto-recorded by handlers/collect.ts when a dispatch dies on
 * quota exhaustion / context overflow.
 */
function operationalDisagreement(taskId: string): PerformanceSignal {
  return {
    type: 'consensus', signal: 'disagreement', taskId, agentId: AGENT,
    counterpartId: 'gemini-reviewer', category: CATEGORY, signal_class: 'operational',
    findingId: `b81956b2-e0fa4ea4:${AGENT}:f2`, source: 'auto',
    evidence: 'Task failed: Context low - stopping', timestamp: now,
  } as PerformanceSignal;
}

/** A `design_split`, which also carries a category in this fixture. */
function categorizedDesignSplit(): PerformanceSignal {
  return {
    type: 'consensus', signal: 'design_split', taskId: 'split-1', agentId: AGENT,
    counterpartId: 'deepseek-challenger', category: CATEGORY, signal_class: 'operational',
    findingId: 'session:2026-07-27-c0ffee01:conditioning-vs-independence', source: 'manual',
    evidence: 'both positions stated', timestamp: now,
  } as PerformanceSignal;
}

function bucketsFor(root: string) {
  const data = readAggregateIndex(root);
  return data?.agents[AGENT]?.[CATEGORY] ?? {};
}

/** Sum every bucket so the comparison is layout-independent. */
function totals(root: string): { correct: number; hallucinated: number; total: number } {
  const out = { correct: 0, hallucinated: 0, total: 0 };
  for (const b of Object.values(bucketsFor(root))) {
    out.correct += b.correct;
    out.hallucinated += b.hallucinated;
    out.total += b.total;
  }
  return out;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('deriveAggregateKey excludes operational-class rows', () => {
  it('does not fold a categorized operational disagreement into the sidecar', () => {
    const rows = [scoringAgreement(), operationalDisagreement('failed-1')];
    writeJsonl(rows);
    new PerformanceWriter(TEST_DIR).__updateAggregateSidecar(rows);

    // Only the real agreement lands. Pre-fix this read `hallucinated: 1`.
    expect(totals(TEST_DIR)).toEqual({ correct: 1, hallucinated: 0, total: 1 });
  });

  it('agrees with rebuildAggregateIndex row-for-row', () => {
    const rows = [
      scoringAgreement(),
      operationalDisagreement('failed-1'),
      operationalDisagreement('failed-2'),
      operationalDisagreement('failed-3'),
    ];
    writeJsonl(rows);

    new PerformanceWriter(TEST_DIR).__updateAggregateSidecar(rows);
    const incremental = totals(TEST_DIR);

    rebuildAggregateIndex(TEST_DIR);
    const rebuilt = totals(TEST_DIR);

    // The whole point: whether you read a freshly-folded sidecar or one rebuilt
    // from raw must not change the answer. Pre-fix these were 3 apart.
    expect(incremental).toEqual(rebuilt);
    expect(incremental.hallucinated).toBe(0);
  });

  it('does not fold a categorized design_split either', () => {
    const rows = [scoringAgreement(), categorizedDesignSplit()];
    writeJsonl(rows);
    new PerformanceWriter(TEST_DIR).__updateAggregateSidecar(rows);

    // Belt and braces: `classifyForAggregate('design_split')` already returns
    // 'none', so this passes on the name gate alone. Pinned anyway so adding
    // design_split to that switch later cannot silently start scoring it.
    expect(totals(TEST_DIR)).toEqual({ correct: 1, hallucinated: 0, total: 1 });
    rebuildAggregateIndex(TEST_DIR);
    expect(totals(TEST_DIR)).toEqual({ correct: 1, hallucinated: 0, total: 1 });
  });

  it('still folds a REAL categorized disagreement (guard is not over-broad)', () => {
    const realVerdict = {
      ...(operationalDisagreement('real-verdict') as unknown as Record<string, unknown>),
      signal_class: 'performance',
      source: 'manual',
      evidence: 'the cited line does not contain the claimed call',
    } as unknown as PerformanceSignal;

    const rows = [scoringAgreement(), realVerdict];
    writeJsonl(rows);
    new PerformanceWriter(TEST_DIR).__updateAggregateSidecar(rows);

    expect(totals(TEST_DIR)).toEqual({ correct: 1, hallucinated: 1, total: 2 });
  });
});
