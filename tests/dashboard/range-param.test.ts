import { getRangeParam, buildUrlWithRange, isRange } from '../../packages/dashboard-v2/src/lib/range-param';

describe('isRange', () => {
  it('accepts known values', () => {
    expect(isRange('1h')).toBe(true);
    expect(isRange('24h')).toBe(true);
    expect(isRange('7d')).toBe(true);
    expect(isRange('30d')).toBe(true);
  });
  it('rejects unknown values', () => {
    expect(isRange('')).toBe(false);
    expect(isRange('5h')).toBe(false);
    expect(isRange('1d')).toBe(false);
    expect(isRange(null as any)).toBe(false);
  });
});

describe('getRangeParam', () => {
  it('returns null when ?range= is absent', () => {
    expect(getRangeParam('')).toBeNull();
    expect(getRangeParam('?other=x')).toBeNull();
  });
  it('returns the value when present and valid', () => {
    expect(getRangeParam('?range=24h')).toBe('24h');
    expect(getRangeParam('?graph=1&range=30d')).toBe('30d');
  });
  it('returns null for an invalid value', () => {
    expect(getRangeParam('?range=garbage')).toBeNull();
    expect(getRangeParam('?range=5h')).toBeNull();
  });
});

describe('buildUrlWithRange', () => {
  it('adds ?range=… when none present', () => {
    expect(buildUrlWithRange('/dashboard/', '', '24h')).toBe('/dashboard/?range=24h');
  });
  it('replaces existing range param', () => {
    expect(buildUrlWithRange('/dashboard/', '?range=7d&graph=1', '24h'))
      .toBe('/dashboard/?range=24h&graph=1');
  });
  it('removes the param when value is null (default range)', () => {
    expect(buildUrlWithRange('/dashboard/', '?range=24h&graph=1', null))
      .toBe('/dashboard/?graph=1');
  });
  it('preserves all other params', () => {
    expect(buildUrlWithRange('/dashboard/', '?agent=opus&graph=1', '1h'))
      .toBe('/dashboard/?agent=opus&graph=1&range=1h');
  });
});
