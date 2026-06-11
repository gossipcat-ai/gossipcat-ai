/**
 * PR-C disk back-compat: consensus reports persisted by older versions carry the
 * deprecated degraded-mode trio (relayCrossReviewSkipped / coverageDegraded /
 * partialReview) but NO `warnings` array. The dashboard read path maps those to
 * synthetic RoundWarnings at READ time so historical rounds still render their
 * degraded modes (spec §4 — the warnings channel subsumes the trio). New reports
 * (carrying `warnings`) pass through untouched.
 */
import { normalizeLegacyDegradedFields } from '../../packages/relay/src/dashboard/routes';

describe('normalizeLegacyDegradedFields — legacy trio → synthetic warnings', () => {
  it('maps coverageDegraded → coverage_degraded warning with counts + dropped agents', () => {
    const out = normalizeLegacyDegradedFields({
      id: 'r1',
      coverageDegraded: { expected: 3, received: 2, droppedAgents: ['gemini-tester'] },
    });
    const cd = (out.warnings ?? []).filter((w: any) => w.code === 'coverage_degraded');
    expect(cd).toHaveLength(1);
    expect(cd[0].message).toContain('2/3');
    expect(cd[0].message).toContain('gemini-tester');
  });

  it('maps relayCrossReviewSkipped → one cross_review_skipped warning per agent (attributed)', () => {
    const out = normalizeLegacyDegradedFields({
      id: 'r2',
      relayCrossReviewSkipped: [
        { agentId: 'gemini-reviewer', reason: 'quota exhausted' },
        { agentId: 'gemini-tester', reason: 'parser produced 0 entries' },
      ],
    });
    const crw = (out.warnings ?? []).filter((w: any) => w.code === 'cross_review_skipped');
    expect(crw).toHaveLength(2);
    expect(crw.map((w: any) => w.agentId).sort()).toEqual(['gemini-reviewer', 'gemini-tester']);
    expect(crw[0].message).toContain('quota exhausted');
  });

  it('maps partialReview:true → partial_review warning', () => {
    const out = normalizeLegacyDegradedFields({ id: 'r3', partialReview: true });
    expect((out.warnings ?? []).some((w: any) => w.code === 'partial_review')).toBe(true);
  });

  it('maps all three trio fields together', () => {
    const out = normalizeLegacyDegradedFields({
      id: 'r4',
      coverageDegraded: { expected: 2, received: 1, droppedAgents: ['a'] },
      relayCrossReviewSkipped: [{ agentId: 'b', reason: 'network' }],
      partialReview: true,
    });
    const codes = (out.warnings ?? []).map((w: any) => w.code).sort();
    expect(codes).toEqual(['coverage_degraded', 'cross_review_skipped', 'partial_review']);
  });

  it('does NOT clobber a report that already carries warnings (new PR-C reports)', () => {
    const existing = [{ code: 'roots_rejected', message: 'x' }];
    const out = normalizeLegacyDegradedFields({
      id: 'r5',
      warnings: existing,
      // even if a stray legacy field is present, the existing warnings win
      partialReview: true,
    });
    expect(out.warnings).toBe(existing);
    expect(out.warnings).toHaveLength(1);
  });

  it('leaves a clean report (no trio, no warnings) untouched — does not crash', () => {
    const report = { id: 'r6', confirmed: [], disputed: [] };
    expect(normalizeLegacyDegradedFields(report)).toBe(report);
  });

  it('tolerates malformed input without throwing', () => {
    expect(normalizeLegacyDegradedFields(null)).toBeNull();
    expect(() => normalizeLegacyDegradedFields({ relayCrossReviewSkipped: 'not-an-array' })).not.toThrow();
  });
});
