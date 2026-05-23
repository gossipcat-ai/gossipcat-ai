import { bucketize, rangeWindowMs, BUCKET_COUNT } from '../../packages/dashboard-v2/src/lib/histogram';

describe('rangeWindowMs', () => {
  it('returns the window duration in ms for each range', () => {
    expect(rangeWindowMs('1h')).toBe(3600_000);
    expect(rangeWindowMs('24h')).toBe(24 * 3600_000);
    expect(rangeWindowMs('7d')).toBe(7 * 24 * 3600_000);
    expect(rangeWindowMs('30d')).toBe(30 * 24 * 3600_000);
  });
});

describe('BUCKET_COUNT', () => {
  it('is 24 (locked by spec)', () => {
    expect(BUCKET_COUNT).toBe(24);
  });
});

describe('bucketize', () => {
  it('returns an array of length 24 even for empty input', () => {
    const buckets = bucketize([], '1h', Date.now());
    expect(buckets).toHaveLength(24);
    expect(buckets.every((b) => b === 0)).toBe(true);
  });

  it('places a single timestamp in the correct bucket', () => {
    const now = new Date('2026-05-23T12:00:00Z').getTime();
    const oneHourAgo = new Date('2026-05-23T11:00:00Z').getTime();
    // 1h range, 24 buckets = 2.5 min each. The timestamp at exactly 60 min ago
    // belongs in bucket 0 (oldest), the timestamp at "now" is at the newest end.
    const buckets = bucketize([new Date(oneHourAgo).toISOString()], '1h', now);
    expect(buckets).toHaveLength(24);
    expect(buckets[0]).toBe(1);
    expect(buckets.slice(1).every((b) => b === 0)).toBe(true);
  });

  it('places a "now" timestamp in the last bucket', () => {
    const now = Date.now();
    const buckets = bucketize([new Date(now - 1).toISOString()], '24h', now);
    expect(buckets[23]).toBe(1);
  });

  it('skips timestamps outside the window', () => {
    const now = new Date('2026-05-23T12:00:00Z').getTime();
    const twoDaysAgo = new Date('2026-05-21T12:00:00Z').getTime();
    const buckets = bucketize([new Date(twoDaysAgo).toISOString()], '24h', now);
    expect(buckets.every((b) => b === 0)).toBe(true);
  });

  it('accumulates multiple timestamps in the same bucket', () => {
    const now = new Date('2026-05-23T12:00:00Z').getTime();
    const t = new Date('2026-05-23T11:55:00Z').toISOString();
    const buckets = bucketize([t, t, t], '1h', now);
    const total = buckets.reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });

  it('ignores invalid timestamps without throwing', () => {
    const now = Date.now();
    const buckets = bucketize(['not-a-date', '', '2026-05-23T12:00:00Z'], '24h', now);
    expect(buckets).toHaveLength(24);
    const total = buckets.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(1);
  });
});
