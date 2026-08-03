import { formatQuotaLine } from '../../apps/cli/src/quota-banner';

describe('formatQuotaLine (issue #732)', () => {
  const NOW = 1_700_000_000_000;

  it('OK when no cooldown and no consecutive429s', () => {
    expect(formatQuotaLine('google', {}, NOW)).toBe('  Quota: google — OK');
  });

  it('EXHAUSTED with a cooldown countdown for an ordinary quota reason while cooling', () => {
    const line = formatQuotaLine('google', { exhaustedUntil: NOW + 30_000, reason: 'quota' }, NOW);
    expect(line).toBe('  Quota: google — EXHAUSTED (30s cooldown)');
  });

  it('SUSPECT when cooldown expired but consecutive429s >= 5', () => {
    const line = formatQuotaLine('google', { exhaustedUntil: NOW - 1, consecutive429s: 5, reason: 'quota' }, NOW);
    expect(line).toBe('  Quota: google — SUSPECT (5 consecutive 429s before cooldown expiry — verify with a real call)');
  });

  it('EXHAUSTED (monthly spend cap) while cooling with reason spend_cap', () => {
    const line = formatQuotaLine('google', { exhaustedUntil: NOW + 60_000, reason: 'spend_cap' }, NOW);
    expect(line).toBe('  Quota: google — EXHAUSTED (monthly spend cap — manage at https://ai.studio/spend)');
  });

  it('an EXPIRED spend_cap cooldown falls through to the ordinary cooling/SUSPECT/OK branches (reason check is cooling-gated)', () => {
    // spend_cap's branch requires `cooling` — once expired it is NOT
    // re-checked against reason, unlike no_quota (see next test).
    const line = formatQuotaLine('google', { exhaustedUntil: NOW - 1, reason: 'spend_cap', consecutive429s: 1 }, NOW);
    expect(line).toBe('  Quota: google — OK');
  });

  it('NO QUOTA while cooling with reason no_quota', () => {
    const line = formatQuotaLine('google', { exhaustedUntil: NOW + 60_000, reason: 'no_quota' }, NOW);
    expect(line).toBe(
      '  Quota: google — NO QUOTA on current plan (free-tier limit is 0 — enable billing; waiting will not fix this)',
    );
  });

  it('an EXPIRED no_quota cooldown still shows NO QUOTA — must NOT fall through to SUSPECT or OK', () => {
    const line = formatQuotaLine('google', { exhaustedUntil: NOW - 1, reason: 'no_quota', consecutive429s: 12 }, NOW);
    expect(line).toContain('NO QUOTA on current plan');
    expect(line).toContain('verify with a real call after enabling billing');
    expect(line).not.toContain('SUSPECT');
    expect(line).not.toContain('OK');
  });

  it('an EXPIRED no_quota cooldown with a LOW consecutive429s count (would be OK for ordinary reasons) still shows NO QUOTA', () => {
    // Regression guard: no_quota must win over the "otherwise OK" branch
    // even when the consecutive429s count is below the SUSPECT threshold.
    const line = formatQuotaLine('google', { exhaustedUntil: NOW - 1, reason: 'no_quota', consecutive429s: 1 }, NOW);
    expect(line).toContain('NO QUOTA on current plan');
    expect(line).not.toBe('  Quota: google — OK');
  });

  it('reason defaults treat missing/undefined reason as ordinary quota', () => {
    const line = formatQuotaLine('google', { exhaustedUntil: NOW + 10_000 }, NOW);
    expect(line).toBe('  Quota: google — EXHAUSTED (10s cooldown)');
  });
});
