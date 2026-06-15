import { MirrorEventStore, MIRROR_RING_MAX } from '@gossip/relay/dashboard/api-mirror-events';

describe('MirrorEventStore', () => {
  // Disable the periodic sweep timer (last ctor arg = 0) so tests drive sweep()
  // explicitly and no timer lingers.
  function store(ringMax = MIRROR_RING_MAX, ttlMs = 1000): MirrorEventStore {
    return new MirrorEventStore(ringMax, ttlMs, 0);
  }

  it('stamps a per-chat_id monotonic id starting at 1 and server ts', () => {
    const s = store();
    const f1 = s.push('chatA', 'user', 'hello', 1_000);
    const f2 = s.push('chatA', 'assistant', 'hi', 2_000);
    expect(f1.id).toBe(1);
    expect(f2.id).toBe(2);
    expect(f1.type).toBe('mirror');
    expect(f1.chat_id).toBe('chatA');
    expect(f1.ts).toBe(new Date(1_000).toISOString());
    expect(f2.ts).toBe(new Date(2_000).toISOString());
  });

  it('keeps INDEPENDENT id counters per chat_id', () => {
    const s = store();
    const a1 = s.push('chatA', 'user', 'a1');
    const b1 = s.push('chatB', 'user', 'b1');
    const a2 = s.push('chatA', 'user', 'a2');
    expect(a1.id).toBe(1);
    expect(b1.id).toBe(1); // chatB's counter is its own — NOT 2
    expect(a2.id).toBe(2);
  });

  it('bounds each ring to ringMax via FIFO eviction (oldest dropped)', () => {
    const s = store(3);
    for (let i = 0; i < 5; i++) s.push('chatA', 'activity', `f${i}`);
    const all = s.replaySlice('chatA', 0);
    expect(all).toHaveLength(3);
    // ids keep climbing (4,5,6) even though only the last 3 are retained.
    expect(all.map((f) => f.id)).toEqual([3, 4, 5]);
    expect(all.map((f) => f.text)).toEqual(['f2', 'f3', 'f4']);
  });

  it('replaySlice returns only frames with id > lastId', () => {
    const s = store();
    for (let i = 0; i < 5; i++) s.push('chatA', 'user', `f${i}`); // ids 1..5
    expect(s.replaySlice('chatA', 0).map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    expect(s.replaySlice('chatA', 3).map((f) => f.id)).toEqual([4, 5]);
    expect(s.replaySlice('chatA', 5)).toEqual([]);
  });

  it('replaySlice on an unknown chat_id returns []', () => {
    const s = store();
    expect(s.replaySlice('nope', 0)).toEqual([]);
  });

  it('highestId reflects the newest retained id, 0 when empty', () => {
    const s = store(2);
    expect(s.highestId('chatA')).toBe(0);
    s.push('chatA', 'user', 'a'); // id 1
    s.push('chatA', 'user', 'b'); // id 2
    s.push('chatA', 'user', 'c'); // id 3, evicts id1
    expect(s.highestId('chatA')).toBe(3);
  });

  it('proactive sweep evicts rings idle longer than the TTL', () => {
    const s = store(MIRROR_RING_MAX, 1000);
    s.push('chatA', 'user', 'a', 10_000);
    s.push('chatB', 'user', 'b', 10_500);
    expect(s.ringCount()).toBe(2);
    // 11_200: chatA idle 1200ms (> ttl) → evicted; chatB idle 700ms → kept.
    s.sweep(11_200);
    expect(s.ringCount()).toBe(1);
    expect(s.replaySlice('chatA', 0)).toEqual([]);
    expect(s.replaySlice('chatB', 0, 11_200)).toHaveLength(1);
  });

  it('replaySlice touches the ring so an actively-read stream survives sweep', () => {
    const s = store(MIRROR_RING_MAX, 1000);
    s.push('chatA', 'user', 'a', 10_000);
    // A reconnecting observer reads at 10_900 (within ttl), refreshing touchedAt.
    s.replaySlice('chatA', 0, 10_900);
    // Sweep at 11_500: without the touch, idle would be 1500ms > ttl. The
    // replay touch at 10_900 makes idle only 600ms → survives.
    s.sweep(11_500);
    expect(s.ringCount()).toBe(1);
  });
});
