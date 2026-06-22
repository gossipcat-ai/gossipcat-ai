import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MirrorEventStore, MIRROR_RING_MAX } from '@gossip/relay/dashboard/api-mirror-events';
import { FileChatStore } from '@gossip/relay/dashboard/chat-store';

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

describe('MirrorEventStore.drainInto (provisional backfill, spec §2)', () => {
  function store(ringMax = MIRROR_RING_MAX, ttlMs = 1000): MirrorEventStore {
    return new MirrorEventStore(ringMax, ttlMs, 0);
  }

  it('re-stamps provisional frames into the destination ring with the dest counter', () => {
    const s = store();
    // Provisional frames accumulate under the reserved id with ids 1,2,3.
    s.push('_provisional', 'activity', 'p0');
    s.push('_provisional', 'user', 'p1');
    s.push('_provisional', 'assistant', 'p2');
    // Destination already has one live frame (id 1).
    s.push('chatA', 'user', 'live');
    const moved = s.drainInto('_provisional', 'chatA');
    // role+text preserved, ids RE-STAMPED onto chatA's counter (continues at 2,3,4).
    expect(moved.map((f) => f.id)).toEqual([2, 3, 4]);
    expect(moved.map((f) => [f.role, f.text])).toEqual([
      ['activity', 'p0'],
      ['user', 'p1'],
      ['assistant', 'p2'],
    ]);
    // Source ring cleared; destination holds 1 live + 3 backfilled.
    expect(s.replaySlice('_provisional', 0)).toEqual([]);
    expect(s.replaySlice('chatA', 0).map((f) => f.id)).toEqual([1, 2, 3, 4]);
  });

  it('caps the merged ring at ringMax via the destination FIFO', () => {
    const s = store(3); // ring max 3
    // The provisional source ring is ALSO FIFO-bounded at ringMax=3, so pushing
    // 4 leaves it holding only the last 3 (p1,p2,p3) — p0 was already evicted.
    for (let i = 0; i < 4; i++) s.push('_provisional', 'activity', `p${i}`);
    expect(s.replaySlice('_provisional', 0)).toHaveLength(3);
    const moved = s.drainInto('_provisional', 'chatA');
    // Those 3 transfer into the (empty) dest ring, re-stamped 1,2,3.
    expect(s.replaySlice('chatA', 0)).toHaveLength(3);
    expect(s.replaySlice('chatA', 0).map((f) => f.text)).toEqual(['p1', 'p2', 'p3']);
    // drainInto returns exactly the frames it transferred.
    expect(moved).toHaveLength(3);
    expect(moved.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('is a no-op for an empty/absent source and clears the empty source ring', () => {
    const s = store();
    expect(s.drainInto('_provisional', 'chatA')).toEqual([]);
    // from === to short-circuit.
    s.push('chatA', 'user', 'x');
    expect(s.drainInto('chatA', 'chatA')).toEqual([]);
    expect(s.replaySlice('chatA', 0)).toHaveLength(1); // untouched
  });
});

// ── Hydration + write-through (FileChatStore integration) ────────────────────

describe('MirrorEventStore — hydration from FileChatStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirror-store-hydration-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function storeWithFile(ringMax = MIRROR_RING_MAX): MirrorEventStore {
    return new MirrorEventStore(ringMax, 60_000, 0, new FileChatStore(dir));
  }

  it('write-through: pushed frames are persisted to disk', () => {
    const s = storeWithFile();
    s.push('chatA', 'user', 'hello', 1000);
    s.push('chatA', 'assistant', 'world', 2000);
    s.dispose();
    // New store instance over same dir: load from disk.
    const s2 = storeWithFile();
    const loaded = s2.replaySlice('chatA', 0);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((f) => f.text)).toEqual(['hello', 'world']);
    s2.dispose();
  });

  it('hydration restores frames and nextId — id sequence CONTINUES across restart', () => {
    const s = storeWithFile();
    s.push('chatA', 'user', 'f1', 1000);
    s.push('chatA', 'user', 'f2', 2000);
    // ids are 1, 2
    s.dispose();
    // Simulated restart: new store instance, same chatDir.
    const s2 = storeWithFile();
    // Push a new frame — id should continue at 3, not reset to 1.
    const f3 = s2.push('chatA', 'user', 'f3', 3000);
    expect(f3.id).toBe(3);
    s2.dispose();
  });

  it('highestId hydrates from disk when ring is cold', () => {
    const s = storeWithFile();
    s.push('chatA', 'user', 'a', 1000);
    s.push('chatA', 'user', 'b', 2000);
    s.dispose();
    // New instance: highestId must trigger hydration, not return 0.
    const s2 = storeWithFile();
    expect(s2.highestId('chatA')).toBe(2);
    s2.dispose();
  });

  it('replaySlice hydrates and returns persisted frames on first access', () => {
    const s = storeWithFile();
    for (let i = 1; i <= 5; i++) s.push('chatA', 'user', `f${i}`, i * 1000);
    s.dispose();
    const s2 = storeWithFile();
    const slice = s2.replaySlice('chatA', 2);
    expect(slice.map((f) => f.id)).toEqual([3, 4, 5]);
    s2.dispose();
  });

  it('NullChatStore default: existing ring tests still pass (no regression)', () => {
    // Verify the NullChatStore default is intact — the store ctor with no arg
    // uses NullChatStore so replaySlice on an unknown ring returns [] as before.
    const s = new MirrorEventStore(MIRROR_RING_MAX, 60_000, 0);
    expect(s.replaySlice('unknown', 0)).toEqual([]);
    expect(s.highestId('unknown')).toBe(0);
    s.push('chatA', 'user', 'hi');
    expect(s.ringCount()).toBe(1);
    s.dispose();
  });

  it('drainInto persists to destination and drops the provisional file', () => {
    const s = storeWithFile();
    // Provisional frames.
    s.push('_provisional', 'activity', 'p0', 1000);
    s.push('_provisional', 'activity', 'p1', 2000);
    s.drainInto('_provisional', 'chatA');
    s.dispose();
    // New instance: chatA should have the drained frames.
    const s2 = storeWithFile();
    const loaded = s2.replaySlice('chatA', 0);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((f) => f.text)).toEqual(['p0', 'p1']);
    // Provisional file should be gone.
    const { existsSync } = require('fs');
    expect(existsSync(join(dir, '_provisional.jsonl'))).toBe(false);
    s2.dispose();
  });

  it('hydrates only the ringMax tail — does not overflow the ring', () => {
    const ringMax = 3;
    const s = storeWithFile(ringMax);
    // Push 6 frames — ring holds only the last 3 in memory, file holds 6.
    for (let i = 1; i <= 6; i++) s.push('chatA', 'user', `f${i}`, i * 1000);
    s.dispose();
    // New instance with same ringMax: hydrate only the last ringMax frames.
    const s2 = storeWithFile(ringMax);
    const slice = s2.replaySlice('chatA', 0);
    expect(slice).toHaveLength(ringMax);
    expect(slice.map((f) => f.id)).toEqual([4, 5, 6]);
    s2.dispose();
  });
});
