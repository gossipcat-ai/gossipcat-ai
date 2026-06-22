/**
 * Tests for the post-collect reconciler helpers (PR #2 of spec
 * 2026-04-27-self-telemetry-remediation).
 *
 * Covers:
 *   - Fix 3a: insights are excluded from `reconcilerFindingsAll`, so
 *     insight-only and insight-bearing rounds no longer trip a spurious
 *     `signal_loss_suspected` (sonnet-reviewer:f6 round 2416d1d5-06ca445b).
 *   - Fix 3b: `buildAlreadySignaledSet` keys per-finding, so an agent with
 *     mixed-verdict findings doesn't have its un-signaled findings dropped
 *     by the dedup filter (sonnet-reviewer:f8 round 2416d1d5-06ca445b).
 *   - Cosmetic C: `reconcilerReviewableCount` returns 0 for rounds that
 *     produced only ephemeral findings, gating the diagnostic away from
 *     meaningless shortfalls (haiku-researcher:f6 round f21444f3-a6294a51).
 */
import {
  reconcilerFindingsAll,
  reconcilerReviewableCount,
  buildAlreadySignaledSet,
  isFindingAlreadySignaled,
} from '../../apps/cli/src/handlers/collect';

describe('reconcilerFindingsAll — Fix 3a: insights excluded', () => {
  it('counts confirmed findings', () => {
    const report = { confirmed: [{ id: 'a', finding: 'x' }] };
    expect(reconcilerFindingsAll(report)).toHaveLength(1);
  });

  it('counts confirmed + disputed + unverified + unique + newFindings', () => {
    const report = {
      confirmed: [{ id: 'c1' }],
      disputed: [{ id: 'd1' }],
      unverified: [{ id: 'u1' }],
      unique: [{ id: 'q1' }],
      newFindings: [{ id: 'n1' }],
    };
    expect(reconcilerFindingsAll(report)).toHaveLength(5);
  });

  it('does NOT count insights — they are observations, not signal-bearing findings', () => {
    const report = {
      confirmed: [{ id: 'c1' }],
      insights: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }],
    };
    // 1 confirmed; the 3 insights are intentionally dropped.
    expect(reconcilerFindingsAll(report)).toHaveLength(1);
  });

  it('insight-only round produces an empty findingsAll baseline', () => {
    const report = { insights: [{ id: 'i1' }, { id: 'i2' }] };
    expect(reconcilerFindingsAll(report)).toHaveLength(0);
  });

  it('handles a fully empty / undefined report shape without throwing', () => {
    expect(reconcilerFindingsAll({})).toEqual([]);
    expect(reconcilerFindingsAll(undefined)).toEqual([]);
    expect(reconcilerFindingsAll(null)).toEqual([]);
  });
});

describe('reconcilerReviewableCount — Cosmetic C: empty-findings gate', () => {
  it('returns 0 when no reviewable buckets are populated (insights-only)', () => {
    const report = { insights: [{ id: 'i1' }, { id: 'i2' }] };
    expect(reconcilerReviewableCount(report)).toBe(0);
  });

  it('returns 0 when only newFindings is populated (no signals emitted for it)', () => {
    const report = { newFindings: [{ id: 'n1' }, { id: 'n2' }] };
    expect(reconcilerReviewableCount(report)).toBe(0);
  });

  it('counts the four reviewable buckets (confirmed/disputed/unverified/unique)', () => {
    const report = {
      confirmed: [{ id: 'c1' }, { id: 'c2' }],
      disputed: [{ id: 'd1' }],
      unverified: [{ id: 'u1' }],
      unique: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }],
      // newFindings + insights MUST NOT be counted in the reviewable bucket.
      newFindings: [{ id: 'n1' }],
      insights: [{ id: 'i1' }],
    };
    expect(reconcilerReviewableCount(report)).toBe(2 + 1 + 1 + 3);
  });

  it('returns 0 for an empty / undefined report', () => {
    expect(reconcilerReviewableCount({})).toBe(0);
    expect(reconcilerReviewableCount(undefined)).toBe(0);
  });
});

describe('buildAlreadySignaledSet + isFindingAlreadySignaled — Fix 3b: per-finding dedup', () => {
  it('keys signals by composite "agentId:findingId" when findingId is present', () => {
    const set = buildAlreadySignaledSet([
      { agentId: 'sonnet-reviewer', findingId: 'aaa-bbb:sonnet-reviewer:f1' },
    ]);
    expect(set.has('sonnet-reviewer:aaa-bbb:sonnet-reviewer:f1')).toBe(true);
    // The bare agentId is NOT in the set when findingId is present — that's
    // the whole point of Fix 3b.
    expect(set.has('sonnet-reviewer')).toBe(false);
  });

  it('legacy fallback: signals without findingId register as agentId-only', () => {
    const set = buildAlreadySignaledSet([
      { agentId: 'old-agent' /* no findingId */ },
    ]);
    expect(set.has('old-agent')).toBe(true);
  });

  it('mixed-verdict findings: confirmed signaled, disputed correctly NOT skipped', () => {
    // Round shape: agent X has two findings, f1 (confirmed, signaled by engine)
    // and f2 (disputed, NOT signaled by engine in this hypothetical bucket).
    // Pre-Fix-3b behavior: agentId-only key meant f2 was wrongly skipped.
    // Post-Fix-3b: f2 should pass through the dedup filter so the provisional
    // path can emit a signal for it.
    const consensusEngineSignals = [
      { agentId: 'sonnet-reviewer', findingId: 'cid-1234:sonnet-reviewer:f1' },
    ];
    const set = buildAlreadySignaledSet(consensusEngineSignals);

    const f1 = { originalAgentId: 'sonnet-reviewer', id: 'cid-1234:sonnet-reviewer:f1' };
    const f2 = { originalAgentId: 'sonnet-reviewer', id: 'cid-1234:sonnet-reviewer:f2' };

    expect(isFindingAlreadySignaled(set, f1)).toBe(true);  // already covered → skip
    expect(isFindingAlreadySignaled(set, f2)).toBe(false); // un-signaled → emit
  });

  it('legacy agentId-only signal still drops all findings for that agent (documented caveat)', () => {
    // Caveat noted in the inline comment + spec: any agent with even one
    // old-format (findingId-less) signal partially reintroduces the bug.
    // This test pins the documented behavior so the fallback isn't quietly
    // tightened without a schema migration.
    const set = buildAlreadySignaledSet([
      { agentId: 'legacy-agent' /* no findingId */ },
    ]);
    const f1 = { originalAgentId: 'legacy-agent', id: 'cid-xyz:legacy-agent:f1' };
    const f2 = { originalAgentId: 'legacy-agent', id: 'cid-xyz:legacy-agent:f2' };

    expect(isFindingAlreadySignaled(set, f1)).toBe(true);
    expect(isFindingAlreadySignaled(set, f2)).toBe(true);
  });

  it('different agents are independent', () => {
    const set = buildAlreadySignaledSet([
      { agentId: 'agent-a', findingId: 'cid:agent-a:f1' },
    ]);
    const f = { originalAgentId: 'agent-b', id: 'cid:agent-b:f1' };
    expect(isFindingAlreadySignaled(set, f)).toBe(false);
  });

  it('empty / undefined signals input yields an empty set', () => {
    expect(buildAlreadySignaledSet(undefined).size).toBe(0);
    expect(buildAlreadySignaledSet([]).size).toBe(0);
  });
});

describe('Reconciler decision matrix — integration of the three fixes', () => {
  // The reconciler in handleCollect emits `signal_loss_suspected` only when
  // (reviewableCount > 0 && actual < findingsCount). These cases pin the
  // decision boundaries the three fixes were designed to enforce.

  // MEDIUM fix (abb91e2d-ce7c478f): shortfall comparison now uses reviewableCount
  // (not findingsAll.length) so newFindings in a mixed round don't inflate the
  // expected count and produce false-positive signal_loss_suspected emissions.
  function shouldEmit(report: any, actualSignalsRecorded: number): boolean {
    const reviewable = reconcilerReviewableCount(report);
    return reviewable > 0 && actualSignalsRecorded < reviewable;
  }

  it('Fix 3a: round with confirmed + insights does NOT emit when actual matches confirmed count', () => {
    // 1 confirmed + 5 insights, engine emitted 1 signal for the confirmed.
    // Pre-Fix-3a: findingsCount=6, actual=1 → spurious shortfall=5 → emit.
    // Post-Fix-3a: findingsCount=1, actual=1 → no shortfall → no emit.
    const report = {
      confirmed: [{ id: 'c1' }],
      insights: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }, { id: 'i4' }, { id: 'i5' }],
    };
    expect(shouldEmit(report, 1)).toBe(false);
  });

  it('Cosmetic C: round with newFindings only does NOT emit even with actual=0', () => {
    const report = { newFindings: [{ id: 'n1' }, { id: 'n2' }] };
    expect(shouldEmit(report, 0)).toBe(false);
  });

  it('MEDIUM fix: mixed round (1 confirmed + 3 newFindings) does NOT emit when engine emitted 1 signal', () => {
    // Regression test for abb91e2d-ce7c478f MEDIUM finding:
    // reviewableCount=1 (confirmed), findingsAll.length=4 (confirmed + newFindings).
    // Pre-fix: compared actual(1) < findingsAll.length(4) → shortfall=3 → false-positive emit.
    // Post-fix: compares actual(1) < reviewableCount(1) → no shortfall → no emit.
    const report = {
      confirmed: [{ id: 'c1' }],
      newFindings: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
    };
    expect(shouldEmit(report, 1)).toBe(false);
  });

  it('Cosmetic C: insights-only round does NOT emit', () => {
    const report = { insights: [{ id: 'i1' }] };
    expect(shouldEmit(report, 0)).toBe(false);
  });

  it('genuine shortfall on a reviewable round still emits', () => {
    const report = {
      confirmed: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
    };
    // Engine wrote only 1 signal for 3 confirmed findings → real shortfall.
    expect(shouldEmit(report, 1)).toBe(true);
  });

  it('happy path: actual >= findingsCount on reviewable round does NOT emit', () => {
    const report = {
      confirmed: [{ id: 'c1' }],
      disputed: [{ id: 'd1' }],
    };
    expect(shouldEmit(report, 2)).toBe(false);
    // Tolerate-double-log path: actual > findingsCount also does not emit.
    expect(shouldEmit(report, 3)).toBe(false);
  });
});
