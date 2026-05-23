import { isGraphHidden } from '../../packages/dashboard-v2/src/lib/feature-flags';

describe('isGraphHidden', () => {
  it('returns true when ?graph=0 is in the search string (explicit opt-out)', () => {
    expect(isGraphHidden('?graph=0')).toBe(true);
    expect(isGraphHidden('?graph=0&other=x')).toBe(true);
    expect(isGraphHidden('?other=x&graph=0')).toBe(true);
  });

  it('returns false when ?graph= is absent (default: graph shown)', () => {
    expect(isGraphHidden('')).toBe(false);
    expect(isGraphHidden('?')).toBe(false);
    expect(isGraphHidden('?other=x')).toBe(false);
  });

  it('returns false for legacy ?graph=1 bookmarks (still shows graph)', () => {
    expect(isGraphHidden('?graph=1')).toBe(false);
  });

  it('returns false for any value other than 0', () => {
    expect(isGraphHidden('?graph=true')).toBe(false);
    expect(isGraphHidden('?graph=false')).toBe(false);
    expect(isGraphHidden('?graph=')).toBe(false);
  });
});
