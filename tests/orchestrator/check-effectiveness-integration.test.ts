/**
 * Integration tests for checkEffectiveness (Tasks 18–20).
 *
 * Spec: docs/superpowers/specs/2026-04-07-checkeffectiveness-redesign.md (Draft v4)
 * Plan: docs/superpowers/plans/2026-04-07-checkeffectiveness-redesign.md Tasks 18–20
 *
 * These are pure-function integration tests — they exercise resolveVerdict directly
 * without filesystem stubs, confirming the end-to-end verdict path for the three
 * canonical outcomes the spec guarantees.
 */

import {
  resolveVerdict,
  type SkillSnapshot,
} from '../../packages/orchestrator/src/check-effectiveness';

// ---------------------------------------------------------------------------
// Task 18 — Integration: Silent skill timeout
// ---------------------------------------------------------------------------

describe('Integration — silent skill (Task 18)', () => {
  it('returns silent_skill when 90 days elapsed with zero post-bind signals', () => {
    const oldBoundAt = new Date(Date.now() - 91 * 86400_000).toISOString();
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 100,
      baseline_accuracy_hallucinated: 20,
      bound_at: oldBoundAt,
      status: 'pending',
      migration_count: 0,
    };
    // v2: caller pre-computes delta via getCountersSince(agentId, category, bound_at_ms)
    // Zero signals since bound_at → delta = { correct: 0, hallucinated: 0 }
    const v = resolveVerdict(snap, { correct: 0, hallucinated: 0 }, Date.now());
    expect(v.status).toBe('silent_skill');
    expect(v.shouldUpdate).toBe(true);
    expect(v.newSnapshotFields?.status).toBe('silent_skill');
  });

  it('does NOT set effectiveness for a silent skill (no delta to measure)', () => {
    const oldBoundAt = new Date(Date.now() - 91 * 86400_000).toISOString();
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 100,
      baseline_accuracy_hallucinated: 20,
      bound_at: oldBoundAt,
      status: 'pending',
      migration_count: 0,
    };
    const v = resolveVerdict(snap, { correct: 0, hallucinated: 0 }, Date.now());
    expect(v.effectiveness).toBeUndefined(); // never set on timeout path
  });
});

// ---------------------------------------------------------------------------
// Task 19 — Integration: Happy path passes at +10pp
// ---------------------------------------------------------------------------

describe('Integration — happy path (passed) (Task 19)', () => {
  it('120 post-bind signals at +10pp accuracy → status: passed', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 75,
      baseline_accuracy_hallucinated: 25,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // Baseline 75% → post-bind 85% → +10pp shift
    // 120 signals at 85%: 102 correct + 18 hallucinated (delta only)
    const v = resolveVerdict(snap, { correct: 102, hallucinated: 18 }, Date.now());
    expect(v.status).toBe('passed');
    expect(v.effectiveness).toBeCloseTo(0.10, 1); // ≈ +10pp
  });
});

// ---------------------------------------------------------------------------
// Task 20 — Integration: Failure path fails at -10pp
// ---------------------------------------------------------------------------

describe('Integration — failure path (failed) (Task 20)', () => {
  it('120 post-bind signals at -10pp accuracy → status: failed', () => {
    const snap: SkillSnapshot = {
      baseline_accuracy_correct: 75,
      baseline_accuracy_hallucinated: 25,
      bound_at: new Date().toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    // Baseline 75% → post-bind 65% → -10pp shift
    // 120 signals at 65%: 78 correct + 42 hallucinated (delta only)
    const v = resolveVerdict(snap, { correct: 78, hallucinated: 42 }, Date.now());
    expect(v.status).toBe('failed');
  });
});
