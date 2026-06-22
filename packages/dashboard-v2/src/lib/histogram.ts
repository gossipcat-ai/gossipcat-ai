import type { Range } from './range-param';

/** Number of buckets across the selected range. Locked by spec §TemporalScrubber. */
export const BUCKET_COUNT = 24;

const RANGE_MS: Record<Range, number> = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

export function rangeWindowMs(range: Range): number {
  return RANGE_MS[range];
}

/**
 * Bucketize a list of ISO timestamps into `BUCKET_COUNT` equal-width
 * buckets ending at `now`. Returns counts per bucket, oldest first.
 *
 *   bucket[0]   = oldest slice (now - window  →  now - window + bucketMs)
 *   bucket[23]  = newest slice (now - bucketMs → now)
 *
 * Pure function. Memoize at the caller.
 */
export function bucketize(timestamps: string[], range: Range, nowMs: number): number[] {
  const window = rangeWindowMs(range);
  const bucketMs = window / BUCKET_COUNT;
  const start = nowMs - window;
  const buckets = new Array<number>(BUCKET_COUNT).fill(0);

  for (const iso of timestamps) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < start || t > nowMs) continue;
    const offset = t - start;
    let idx = Math.floor(offset / bucketMs);
    if (idx >= BUCKET_COUNT) idx = BUCKET_COUNT - 1; // include the boundary
    buckets[idx] += 1;
  }
  return buckets;
}
