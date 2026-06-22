/**
 * Stage 2 premise-verification — modality-scaled hallucination multiplier.
 *
 * Confirms that `signal.modality` on a `hallucination_caught` with
 * `outcome: 'premise_mismatch'` scales the penalty baked into
 * `weightedHallucinations`:
 *   - asserted (or missing) → 3.0×
 *   - hedged              → 1.5×
 *   - vague               → 1.0×
 *
 * `fabricated_citation` and `confirmed_hallucination` stay at flat 3.0×
 * regardless of modality — Stage 2 explicitly only scales `premise_mismatch`.
 *
 * The reader exposes `weightedHallucinations` on the score row, so we assert
 * on that field directly rather than back-deriving from `accuracy`.
 *
 * Spec: docs/specs/2026-04-22-premise-verification-stage-2.md §Signal integration.
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';

const TMP = join(__dirname, '..', '..', '.test-tmp-signal-modality');

function writeSignals(signals: object[]): void {
  mkdirSync(join(TMP, '.gossip'), { recursive: true });
  writeFileSync(
    join(TMP, '.gossip', 'agent-performance.jsonl'),
    signals.map(s => JSON.stringify(s)).join('\n'),
  );
}

function premiseMismatch(
  agentId: string,
  modality: 'asserted' | 'hedged' | 'vague' | undefined,
) {
  const base: Record<string, unknown> = {
    type: 'consensus',
    taskId: `task-${agentId}`,
    signal: 'hallucination_caught',
    outcome: 'premise_mismatch',
    agentId,
    evidence: 'premise mismatch test',
    timestamp: new Date().toISOString(),
  };
  if (modality !== undefined) base.modality = modality;
  return base;
}

afterEach(() => {
  try { rmSync(TMP, { recursive: true }); } catch { /* noop */ }
});

describe('hallucination_caught — modality-scaled multiplier (Stage 2)', () => {
  test('premise_mismatch + modality=asserted → 3.0× (base)', () => {
    writeSignals([premiseMismatch('a-asserted', 'asserted')]);
    const reader = new PerformanceReader(TMP);
    const score = reader.getScores().get('a-asserted')!;
    // HALLUCINATION_DECAY_HALF_LIFE applies — with a single signal and
    // tasksSince = 0 at the trailing edge, the decay factor is 1.0 and
    // weightedHallucinations equals the raw multiplier.
    expect(score.weightedHallucinations).toBeCloseTo(3.0, 5);
  });

  test('premise_mismatch + modality=hedged → 1.5×', () => {
    writeSignals([premiseMismatch('a-hedged', 'hedged')]);
    const reader = new PerformanceReader(TMP);
    const score = reader.getScores().get('a-hedged')!;
    expect(score.weightedHallucinations).toBeCloseTo(1.5, 5);
  });

  test('premise_mismatch + modality=vague → 1.0×', () => {
    writeSignals([premiseMismatch('a-vague', 'vague')]);
    const reader = new PerformanceReader(TMP);
    const score = reader.getScores().get('a-vague')!;
    expect(score.weightedHallucinations).toBeCloseTo(1.0, 5);
  });

  test('premise_mismatch + missing modality → 3.0× (back-compat fallback to asserted)', () => {
    writeSignals([premiseMismatch('a-missing', undefined)]);
    const reader = new PerformanceReader(TMP);
    const score = reader.getScores().get('a-missing')!;
    // Pre-Stage-2 signals have no modality field; strictest path preserves the
    // 3.0× penalty the Stage 1 ship already applied, so old data keeps scoring
    // identically.
    expect(score.weightedHallucinations).toBeCloseTo(3.0, 5);
  });

  test('fabricated_citation stays flat 3.0× even with modality set', () => {
    // Stage 2 only scales the premise_mismatch arm — modality on a
    // fabricated_citation signal is ignored for scaling (forward-compat, not
    // semantically meaningful yet).
    writeSignals([
      {
        type: 'consensus',
        taskId: 'task-fab',
        signal: 'hallucination_caught',
        outcome: 'fabricated_citation',
        agentId: 'a-fab',
        modality: 'hedged', // should be ignored for scaling
        evidence: 'fab test',
        timestamp: new Date().toISOString(),
      },
    ]);
    const reader = new PerformanceReader(TMP);
    const score = reader.getScores().get('a-fab')!;
    expect(score.weightedHallucinations).toBeCloseTo(3.0, 5);
  });
});
