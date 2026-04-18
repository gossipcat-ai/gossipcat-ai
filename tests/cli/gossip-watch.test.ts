import { filterWatchEvents, WATCH_EVIDENCE_CAP, WATCH_MAX_EVENTS, WATCH_MAX_LOOKBACK_MS } from '../../apps/cli/src/gossip-watch';

const iso = (ms: number) => new Date(ms).toISOString();
const line = (obj: Record<string, unknown>) => JSON.stringify(obj);

describe('filterWatchEvents', () => {
  const now = Date.UTC(2026, 3, 17, 12, 0, 0);

  test('returns empty result for empty jsonl', () => {
    const res = filterWatchEvents('', { now });
    expect(res.events).toEqual([]);
    expect(res.count).toBe(0);
    expect(res.truncated).toBe(false);
  });

  test('returns events strictly newer than cursor', () => {
    const raw = [
      line({ timestamp: iso(now - 60_000), signal: 'old' }),
      line({ timestamp: iso(now - 30_000), signal: 'cursor' }),
      line({ timestamp: iso(now - 10_000), signal: 'new' }),
    ].join('\n');
    const res = filterWatchEvents(raw, { cursor: iso(now - 30_000), now });
    expect(res.events.map(e => e.signal)).toEqual(['new']);
    expect(res.count).toBe(1);
  });

  test('snaps cursor older than 24h to the floor', () => {
    const raw = [
      line({ timestamp: iso(now - WATCH_MAX_LOOKBACK_MS - 60_000), signal: 'ancient' }),
      line({ timestamp: iso(now - WATCH_MAX_LOOKBACK_MS + 60_000), signal: 'within-window' }),
    ].join('\n');
    const res = filterWatchEvents(raw, { cursor: iso(now - 48 * 60 * 60 * 1000), now });
    expect(res.events.map(e => e.signal)).toEqual(['within-window']);
  });

  test('no cursor defaults to 24h floor', () => {
    const raw = [
      line({ timestamp: iso(now - WATCH_MAX_LOOKBACK_MS - 1000), signal: 'ancient' }),
      line({ timestamp: iso(now - 1000), signal: 'recent' }),
    ].join('\n');
    const res = filterWatchEvents(raw, { now });
    expect(res.events.map(e => e.signal)).toEqual(['recent']);
  });

  test('returns chronological order', () => {
    const raw = [
      line({ timestamp: iso(now - 30_000), signal: 'a' }),
      line({ timestamp: iso(now - 20_000), signal: 'b' }),
      line({ timestamp: iso(now - 10_000), signal: 'c' }),
    ].join('\n');
    const res = filterWatchEvents(raw, { cursor: iso(now - 60_000), now });
    expect(res.events.map(e => e.signal)).toEqual(['a', 'b', 'c']);
  });

  test('redacts evidence field over cap', () => {
    const longEvidence = 'x'.repeat(WATCH_EVIDENCE_CAP + 100);
    const raw = line({ timestamp: iso(now - 1000), signal: 'hit', evidence: longEvidence });
    const res = filterWatchEvents(raw, { cursor: iso(now - 5000), now });
    const ev = res.events[0].evidence as string;
    expect(ev.length).toBeLessThan(longEvidence.length);
    expect(ev).toContain('[truncated');
  });

  test('does not truncate short evidence', () => {
    const raw = line({ timestamp: iso(now - 1000), signal: 'hit', evidence: 'short reason' });
    const res = filterWatchEvents(raw, { cursor: iso(now - 5000), now });
    expect(res.events[0].evidence).toBe('short reason');
  });

  test('caps events at max_events and reports truncated', () => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      line({ timestamp: iso(now - (600 - i) * 100), signal: `s${i}` }),
    );
    const res = filterWatchEvents(lines.join('\n'), { cursor: iso(now - 120_000), maxEvents: 50, now });
    expect(res.events.length).toBe(50);
    expect(res.truncated).toBe(true);
  });

  test('next_cursor advances to last event timestamp', () => {
    const latest = iso(now - 1000);
    const raw = [
      line({ timestamp: iso(now - 3000), signal: 'a' }),
      line({ timestamp: latest, signal: 'b' }),
    ].join('\n');
    const res = filterWatchEvents(raw, { cursor: iso(now - 5000), now });
    expect(res.next_cursor).toBe(latest);
  });

  test('next_cursor stays at sinceMs when no events match', () => {
    const raw = line({ timestamp: iso(now - 60_000), signal: 'old' });
    const cursor = iso(now - 30_000);
    const res = filterWatchEvents(raw, { cursor, now });
    expect(res.events.length).toBe(0);
    expect(res.next_cursor).toBe(cursor);
  });

  test('ignores malformed json lines and invalid timestamps', () => {
    const raw = [
      'not json',
      line({ timestamp: 'not-a-date', signal: 'bad-ts' }),
      line({ signal: 'no-ts' }),
      line({ timestamp: iso(now - 1000), signal: 'good' }),
      '',
    ].join('\n');
    const res = filterWatchEvents(raw, { cursor: iso(now - 5000), now });
    expect(res.events.map(e => e.signal)).toEqual(['good']);
  });

  test('max_events caps above WATCH_MAX_EVENTS to WATCH_MAX_EVENTS', () => {
    const lines = Array.from({ length: 1000 }, (_, i) =>
      line({ timestamp: iso(now - (1000 - i) * 100), signal: `s${i}` }),
    );
    const res = filterWatchEvents(lines.join('\n'), { cursor: iso(now - 200_000), maxEvents: 10_000, now });
    expect(res.events.length).toBeLessThanOrEqual(WATCH_MAX_EVENTS);
  });
});
