import {
  oneSidedZTest,
  resolveVerdict,
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
    baseline_accuracy_correct: 50,
    baseline_accuracy_hallucinated: 50,
    bound_at: '2026-04-01T00:00:00Z',
    status: 'pending',
    migration_count: 0,
  };

  function counters(correct: number, hallucinated: number): CategoryCounters {
    return { correct, hallucinated };
  }

  it('returns pending when post-bind delta is below MIN_EVIDENCE', () => {
    const v = resolveVerdict(baseSnapshot, counters(10, 10), Date.now());
    expect(v.status).toBe('pending');
  });

  it('returns passed when delta clears z-test in positive direction', () => {
    // Baseline 50%. Delta: 108/120 ≈ 90%
    const v = resolveVerdict(baseSnapshot, counters(108, 12), Date.now());
    expect(v.status).toBe('passed');
  });

  it('returns failed when delta clears z-test in negative direction', () => {
    // Baseline 50%. Delta: 24/120 = 20%
    const v = resolveVerdict(baseSnapshot, counters(24, 96), Date.now());
    expect(v.status).toBe('failed');
  });

  it('returns inconclusive when gate met but neither test rejects', () => {
    // Baseline 50%, delta 55%
    const v = resolveVerdict(baseSnapshot, counters(66, 54), Date.now());
    expect(v.status).toBe('inconclusive');
  });

  it('returns silent_skill when 90 days elapsed with zero post-bind signals', () => {
    const old = new Date(Date.now() - 91 * 86400_000).toISOString();
    const v = resolveVerdict({ ...baseSnapshot, bound_at: old }, counters(0, 0), Date.now());
    expect(v.status).toBe('silent_skill');
  });

  it('returns insufficient_evidence when 90 days elapsed with some signals but gate never met', () => {
    const old = new Date(Date.now() - 91 * 86400_000).toISOString();
    const v = resolveVerdict({ ...baseSnapshot, bound_at: old }, counters(20, 10), Date.now()); // delta=30 < 120
    expect(v.status).toBe('insufficient_evidence');
  });

  it('returns flagged_for_manual_review and short-circuits when status is already flagged', () => {
    const flagged = { ...baseSnapshot, status: 'flagged_for_manual_review' as const };
    const v = resolveVerdict(flagged, counters(500, 500), Date.now());
    expect(v.status).toBe('flagged_for_manual_review');
    expect(v.shouldUpdate).toBe(false);
  });

  it('returns not_applicable for implementer agents', () => {
    const v = resolveVerdict(baseSnapshot, counters(0, 0), Date.now(), { role: 'implementer' });
    expect(v.status).toBe('not_applicable');
  });
});
