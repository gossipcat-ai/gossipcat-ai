import { signalsHandler } from '../../packages/relay/src/dashboard/api-signals';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface SeedRec {
  type?: string;
  signal: string;
  agentId: string;
  counterpartId?: string;
  consensusId?: string;
  findingId?: string;
  severity?: string;
  category?: string;
  source?: string;
  timestamp: string;
  evidence?: string;
}

function seed(recs: SeedRec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-test-sig-filters-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  const lines = recs
    .map((r) => JSON.stringify({ type: 'consensus', ...r }))
    .join('\n') + '\n';
  writeFileSync(join(root, '.gossip', 'agent-performance.jsonl'), lines);
  return root;
}

describe('signalsHandler — server-side filters + cursor pagination', () => {
  it('filters by counterpart', async () => {
    const root = seed([
      { signal: 'agreement', agentId: 'a', counterpartId: 'x', timestamp: '2026-04-17T10:00:00.000Z' },
      { signal: 'agreement', agentId: 'b', counterpartId: 'y', timestamp: '2026-04-17T10:01:00.000Z' },
      { signal: 'agreement', agentId: 'c', counterpartId: 'x', timestamp: '2026-04-17T10:02:00.000Z' },
    ]);
    const res = await signalsHandler(root, new URLSearchParams({ counterpart: 'x' }));
    expect(res.items).toHaveLength(2);
    expect(res.items.every((i) => i.counterpartId === 'x')).toBe(true);
  });

  it('filters by signal multi-select', async () => {
    const root = seed([
      { signal: 'agreement', agentId: 'a', timestamp: '2026-04-17T10:00:00.000Z' },
      { signal: 'hallucination_caught', agentId: 'b', timestamp: '2026-04-17T10:01:00.000Z' },
      { signal: 'unique_confirmed', agentId: 'c', timestamp: '2026-04-17T10:02:00.000Z' },
      { signal: 'disagreement', agentId: 'd', timestamp: '2026-04-17T10:03:00.000Z' },
    ]);
    const q = new URLSearchParams();
    q.append('signal', 'hallucination_caught');
    q.append('signal', 'disagreement');
    const res = await signalsHandler(root, q);
    expect(res.items).toHaveLength(2);
    const sigs = res.items.map((i) => i.signal).sort();
    expect(sigs).toEqual(['disagreement', 'hallucination_caught']);
  });

  it('filters by since/until time window', async () => {
    const root = seed([
      { signal: 'agreement', agentId: 'a', timestamp: '2026-04-17T09:00:00.000Z' },
      { signal: 'agreement', agentId: 'b', timestamp: '2026-04-17T10:00:00.000Z' },
      { signal: 'agreement', agentId: 'c', timestamp: '2026-04-17T11:00:00.000Z' },
      { signal: 'agreement', agentId: 'd', timestamp: '2026-04-17T12:00:00.000Z' },
    ]);
    const res = await signalsHandler(
      root,
      new URLSearchParams({ since: '2026-04-17T10:00:00.000Z', until: '2026-04-17T12:00:00.000Z' })
    );
    expect(res.items.map((i) => i.agentId).sort()).toEqual(['b', 'c']);
  });

  it('filters by consensus_id prefix', async () => {
    const root = seed([
      { signal: 'agreement', agentId: 'a', consensusId: 'abc123-def456', timestamp: '2026-04-17T10:00:00.000Z' },
      { signal: 'agreement', agentId: 'b', consensusId: 'abc123-ghi789', timestamp: '2026-04-17T10:01:00.000Z' },
      { signal: 'agreement', agentId: 'c', consensusId: 'zzz999-xxx000', timestamp: '2026-04-17T10:02:00.000Z' },
    ]);
    const res = await signalsHandler(root, new URLSearchParams({ consensus_id: 'abc123' }));
    expect(res.items).toHaveLength(2);
    expect(res.items.every((i) => i.consensusId?.startsWith('abc123'))).toBe(true);
  });

  it('cursor pagination returns nextCursor then remainder', async () => {
    const recs: SeedRec[] = [];
    for (let i = 0; i < 5; i++) {
      // Ordering: later i → later timestamp (newest last in seed, newest first after sort)
      const ts = `2026-04-17T10:0${i}:00.000Z`;
      recs.push({ signal: 'agreement', agentId: `a${i}`, timestamp: ts });
    }
    const root = seed(recs);
    const page1 = await signalsHandler(root, new URLSearchParams({ limit: '2' }));
    expect(page1.items).toHaveLength(2);
    // Newest-first: a4, a3
    expect(page1.items.map((i) => i.agentId)).toEqual(['a4', 'a3']);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await signalsHandler(
      root,
      new URLSearchParams({ limit: '2', cursor: page1.nextCursor as string })
    );
    expect(page2.items).toHaveLength(2);
    expect(page2.items.map((i) => i.agentId)).toEqual(['a2', 'a1']);
    expect(page2.nextCursor).toBeTruthy();

    const page3 = await signalsHandler(
      root,
      new URLSearchParams({ limit: '2', cursor: page2.nextCursor as string })
    );
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].agentId).toBe('a0');
    expect(page3.nextCursor).toBeUndefined();
  });

  it('source inference buckets impl_* and meta signals', async () => {
    const root = seed([
      { signal: 'impl_test_pass', agentId: 'a', timestamp: '2026-04-17T10:00:00.000Z' },
      { signal: 'task_completed', agentId: 'b', timestamp: '2026-04-17T10:01:00.000Z' },
      { signal: 'agreement', agentId: 'c', timestamp: '2026-04-17T10:02:00.000Z' },
      { signal: 'tool_turns', agentId: 'd', timestamp: '2026-04-17T10:03:00.000Z' },
    ]);

    const impl = await signalsHandler(root, new URLSearchParams({ source: 'impl' }));
    expect(impl.items).toHaveLength(1);
    expect(impl.items[0].signal).toBe('impl_test_pass');

    const meta = await signalsHandler(root, new URLSearchParams({ source: 'meta' }));
    expect(meta.items.map((i) => i.signal).sort()).toEqual(['task_completed', 'tool_turns']);

    const manual = await signalsHandler(root, new URLSearchParams({ source: 'manual' }));
    expect(manual.items).toHaveLength(1);
    expect(manual.items[0].signal).toBe('agreement');
  });
});
