import { describe, it, expect } from 'vitest';
import {
  oneSidedZTest,
  resolveVerdict,
  MIN_EVIDENCE,
  ALPHA,
  type SkillSnapshot,
  type CategoryCounters,
} from '../../packages/orchestrator/src/check-effectiveness';

describe('oneSidedZTest', () => {
  it('rejects H0 when post is significantly higher than baseline', () => {
    // baseline 50% (50/100), post 90% (90/100) — strong positive
    const r = oneSidedZTest({ correct: 90, total: 100 }, 0.5, 'positive');
    expect(r.rejects).toBe(true);
    expect(r.zScore).toBeGreaterThan(1.96); // α=0.025 → z* ≈ 1.96
  });

  it('does not reject H0 when post matches baseline', () => {
    const r = oneSidedZTest({ correct: 50, total: 100 }, 0.5, 'positive');
    expect(r.rejects).toBe(false);
  });

  it('rejects H0 in negative direction when post is significantly lower', () => {
    const r = oneSidedZTest({ correct: 30, total: 100 }, 0.7, 'negative');
    expect(r.rejects).toBe(true);
  });

  // Bug 5 — oneSidedZTest negative-total guard
  it('returns { rejects: false, zScore: 0 } when total is negative (defense in depth)', () => {
    const r = oneSidedZTest({ correct: -5, total: -10 }, 0.5, 'positive');
    expect(r.rejects).toBe(false);
    expect(r.zScore).toBe(0);
  });
});

describe('resolveVerdict', () => {
  const baseSnapshot: SkillSnapshot = {
    baseline_correct: 50,
    baseline_hallucinated: 50,
    bound_at: '2026-04-01T00:00:00Z',
    status: 'pending',
    migration_count: 0,
  };

  function counters(correct: number, hallucinated: number): CategoryCounters {
    return { correct, hallucinated };
  }

  it('returns pending when post-bind delta is below MIN_EVIDENCE', () => {
    const v = resolveVerdict(baseSnapshot, counters(60, 60), Date.now());
    expect(v.status).toBe('pending');
  });

  it('returns passed when delta clears z-test in positive direction', () => {
    // Baseline: 50/100 = 50%. Post-bind: +120 signals at 90% accuracy → 108/120
    const v = resolveVerdict(baseSnapshot, counters(50 + 108, 50 + 12), Date.now());
    expect(v.status).toBe('passed');
  });

  it('returns failed when delta clears z-test in negative direction', () => {
    // Baseline: 50/100 = 50%. Post-bind: 120 signals at 20% → 24/120
    const v = resolveVerdict(baseSnapshot, counters(50 + 24, 50 + 96), Date.now());
    expect(v.status).toBe('failed');
  });

  it('returns inconclusive when gate met but neither test rejects', () => {
    // Baseline 50%, post 55% (slight increase, not significant at α=0.025 with N=120)
    const v = resolveVerdict(baseSnapshot, counters(50 + 66, 50 + 54), Date.now());
    expect(v.status).toBe('inconclusive');
  });

  it('returns silent_skill when 90 days elapsed with zero post-bind signals', () => {
    const old = new Date(Date.now() - 91 * 86400_000).toISOString();
    const v = resolveVerdict({ ...baseSnapshot, bound_at: old }, counters(50, 50), Date.now());
    expect(v.status).toBe('silent_skill');
  });

  it('returns insufficient_evidence when 90 days elapsed with some signals but gate never met', () => {
    const old = new Date(Date.now() - 91 * 86400_000).toISOString();
    const v = resolveVerdict({ ...baseSnapshot, bound_at: old }, counters(70, 60), Date.now()); // delta=30 < 120
    expect(v.status).toBe('insufficient_evidence');
  });

  it('returns flagged_for_manual_review and short-circuits when status is already flagged', () => {
    const flagged = { ...baseSnapshot, status: 'flagged_for_manual_review' as const };
    const v = resolveVerdict(flagged, counters(500, 500), Date.now());
    expect(v.status).toBe('flagged_for_manual_review');
    expect(v.shouldUpdate).toBe(false);
  });

  it('returns not_applicable for implementer agents', () => {
    // Implementer agents are signaled by an explicit role parameter passed in (not in baseSnapshot).
    // This test fixes the contract: resolveVerdict accepts an optional role argument.
    const v = resolveVerdict(baseSnapshot, counters(0, 0), Date.now(), { role: 'implementer' });
    expect(v.status).toBe('not_applicable');
  });

  // Bug 1 — Negative postTotal from signal expiry
  it('returns pending when postTotal goes negative due to signal expiry', () => {
    // Baseline snapshotted with cumulative signals: 100 correct + 20 hallucinated.
    // After 30 days, expired signals fall out of live counters: only 60 correct + 10 hallucinated remain.
    // deltaCorrect = -40, deltaHallucinated = -10, postTotal = -50.
    const snap: SkillSnapshot = {
      baseline_correct: 100,
      baseline_hallucinated: 20,
      bound_at: new Date(Date.now() - 45 * 86400_000).toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    const v = resolveVerdict(snap, { correct: 60, hallucinated: 10 }, Date.now());
    expect(v.status).toBe('pending');
    expect(v.shouldUpdate).toBe(false);
  });

  it('returns pending (not insufficient_evidence) when postTotal is negative AND timeout has fired', () => {
    // Same scenario but skill is 91 days old — without the guard, the timeout branch fires
    // and returns insufficient_evidence (wrong). With the guard it returns pending/shouldUpdate:false.
    const snap: SkillSnapshot = {
      baseline_correct: 100,
      baseline_hallucinated: 20,
      bound_at: new Date(Date.now() - 91 * 86400_000).toISOString(),
      status: 'pending',
      migration_count: 0,
    };
    const v = resolveVerdict(snap, { correct: 60, hallucinated: 10 }, Date.now());
    expect(v.status).toBe('pending');
    expect(v.shouldUpdate).toBe(false);
  });
});
