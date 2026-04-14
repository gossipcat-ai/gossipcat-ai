/**
 * Generic sliding-window rate limiter.
 *
 * Supports both COUNT mode (each event has weight=1, e.g. relay message rate
 * gate) and WEIGHTED-SUM mode (each event has a numeric weight, e.g. HTTP
 * bridge in-flight-bytes quota where weight = request size in bytes).
 *
 * Per-key state is a list of `{ ts, weight }` records inside the current
 * window. Records older than `windowMs` are purged on every access — this
 * keeps the per-key Map bounded by the window's request rate, not by total
 * lifetime activity.
 *
 * Time source is `Date.now()` to match the existing
 * `MessageRateLimiter` behaviour and the spec's 60-second window semantics.
 */

interface Entry {
  ts: number;
  weight: number;
}

export class RateLimiter {
  private entries = new Map<string, Entry[]>();
  private readonly windowMs: number;
  private readonly maxWeight: number;

  /**
   * @param windowMs Sliding window size in milliseconds.
   * @param maxWeight Cap on the SUM of weights inside the window. For
   *   count-mode use `weight=1` per call and pass the count cap here.
   */
  constructor(windowMs: number, maxWeight: number) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`RateLimiter: windowMs must be > 0, got ${windowMs}`);
    }
    if (!Number.isFinite(maxWeight) || maxWeight <= 0) {
      throw new Error(`RateLimiter: maxWeight must be > 0, got ${maxWeight}`);
    }
    this.windowMs = windowMs;
    this.maxWeight = maxWeight;
  }

  /**
   * Record an event of `weight` (default 1) for `key`.
   * Returns `true` if the new event fits inside the window's budget,
   * `false` if it would exceed `maxWeight` (in which case the event is NOT
   * recorded — callers can retry later when the window rolls).
   *
   * A single event whose own weight already exceeds `maxWeight` is rejected
   * outright (returns `false`, nothing recorded). This matches the spec's
   * intent: a 60MB single read should not pass a 50MB/min budget by being
   * the first request of a new window.
   */
  record(key: string, weight: number = 1): boolean {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`RateLimiter: weight must be a non-negative finite number, got ${weight}`);
    }
    if (weight > this.maxWeight) return false;

    const now = Date.now();
    const list = this.purge(key, now);
    const currentSum = list.reduce((acc, e) => acc + e.weight, 0);
    if (currentSum + weight > this.maxWeight) return false;

    list.push({ ts: now, weight });
    this.entries.set(key, list);
    return true;
  }

  /**
   * Sum of weights inside the current window for `key`. Purges expired
   * entries as a side effect to keep the Map bounded under read-only access.
   */
  currentWeight(key: string): number {
    const now = Date.now();
    const list = this.purge(key, now);
    return list.reduce((acc, e) => acc + e.weight, 0);
  }

  /** Drop all tracking state. Test helper. */
  clear(): void {
    this.entries.clear();
  }

  private purge(key: string, now: number): Entry[] {
    const cutoff = now - this.windowMs;
    const list = this.entries.get(key);
    if (!list || list.length === 0) {
      const fresh: Entry[] = [];
      this.entries.set(key, fresh);
      return fresh;
    }
    // Entries are appended in `now`-order, so the expired prefix is contiguous.
    let firstLive = 0;
    while (firstLive < list.length && list[firstLive].ts <= cutoff) firstLive++;
    if (firstLive === 0) return list;
    const trimmed = list.slice(firstLive);
    if (trimmed.length === 0) {
      // Don't accumulate empty arrays for keys that have gone quiet.
      this.entries.delete(key);
      const fresh: Entry[] = [];
      this.entries.set(key, fresh);
      return fresh;
    }
    this.entries.set(key, trimmed);
    return trimmed;
  }
}
