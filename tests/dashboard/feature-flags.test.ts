import { isGraphBeta } from '../../packages/dashboard-v2/src/lib/feature-flags';

describe('isGraphBeta', () => {
  it('returns true when ?graph=1 is in the search string', () => {
    expect(isGraphBeta('?graph=1')).toBe(true);
    expect(isGraphBeta('?graph=1&other=x')).toBe(true);
    expect(isGraphBeta('?other=x&graph=1')).toBe(true);
  });
  it('returns false when ?graph= is absent or set to anything but 1', () => {
    expect(isGraphBeta('')).toBe(false);
    expect(isGraphBeta('?')).toBe(false);
    expect(isGraphBeta('?graph=0')).toBe(false);
    expect(isGraphBeta('?graph=true')).toBe(false);
    expect(isGraphBeta('?other=x')).toBe(false);
  });
});
