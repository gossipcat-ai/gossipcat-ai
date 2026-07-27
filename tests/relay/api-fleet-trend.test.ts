import { fleetTrendHandler } from '../../packages/relay/src/dashboard/api-fleet-trend';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('fleetTrendHandler', () => {
  function makeRoot(records: Record<string, unknown>[]): string {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-fleet-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    writeFileSync(
      join(root, '.gossip', 'agent-performance.jsonl'),
      records.map(r => JSON.stringify(r)).join('\n') + '\n',
    );
    return root;
  }

  it('returns per-day per-agent accuracy buckets from agent-performance.jsonl', async () => {
    const now = new Date().toISOString();
    const root = makeRoot([
      { type: 'consensus', signal: 'agreement', agentId: 'alice', timestamp: now },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'alice', timestamp: now },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'bob', timestamp: now },
    ]);
    const res = await fleetTrendHandler(root);
    expect(res.days).toBe(30);
    const alice = res.points.find(p => p.agentId === 'alice');
    const bob = res.points.find(p => p.agentId === 'bob');
    expect(alice).toBeDefined();
    expect(alice!.signals).toBe(2);
    expect(alice!.accuracy).toBe(0.5);
    expect(bob!.accuracy).toBe(1);
    expect(bob!.signals).toBe(1);
  });

  it('filters out entries older than the days window', async () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const root = makeRoot([
      { type: 'consensus', signal: 'agreement', agentId: 'alice', timestamp: recent },
      { type: 'consensus', signal: 'agreement', agentId: 'alice', timestamp: old },
    ]);
    const res = await fleetTrendHandler(root, new URLSearchParams({ days: '30' }));
    const alice = res.points.find(p => p.agentId === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.signals).toBe(1);
  });

  it('excludes _system sentinel agent', async () => {
    const now = new Date().toISOString();
    const root = makeRoot([
      { type: 'consensus', signal: 'consensus_round_retracted', agentId: '_system', timestamp: now },
      { type: 'consensus', signal: 'agreement', agentId: 'alice', timestamp: now },
    ]);
    const res = await fleetTrendHandler(root);
    expect(res.points.some(p => p.agentId === '_system')).toBe(false);
    expect(res.points.some(p => p.agentId === 'alice')).toBe(true);
  });

  // Issue #678. `total` here is the accuracy DENOMINATOR, and an operational
  // row can never increment `good` — so leaving it in silently drags the
  // plotted accuracy down. For `design_split` that means both named agents
  // visibly lose accuracy for holding a defensible position, which is the
  // outcome the signal exists to prevent.
  it('excludes operational-class rows from the accuracy denominator', async () => {
    const now = new Date().toISOString();
    const root = makeRoot([
      { type: 'consensus', signal: 'agreement', agentId: 'alice', timestamp: now },
      {
        type: 'consensus', signal: 'design_split', agentId: 'alice',
        counterpartId: 'bob', signal_class: 'operational', timestamp: now,
      },
      {
        type: 'consensus', signal: 'operational_lesson', agentId: 'alice',
        signal_class: 'operational', timestamp: now,
      },
    ]);
    const res = await fleetTrendHandler(root);
    const alice = res.points.find(p => p.agentId === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.signals).toBe(1);
    expect(alice!.accuracy).toBe(1);
  });

  it('still counts a real (performance-class) verdict against accuracy', async () => {
    const now = new Date().toISOString();
    const root = makeRoot([
      { type: 'consensus', signal: 'agreement', agentId: 'alice', timestamp: now },
      {
        type: 'consensus', signal: 'disagreement', agentId: 'alice',
        signal_class: 'performance', category: 'trust_boundaries', timestamp: now,
      },
    ]);
    const res = await fleetTrendHandler(root);
    const alice = res.points.find(p => p.agentId === 'alice');
    expect(alice!.signals).toBe(2);
    expect(alice!.accuracy).toBe(0.5);
  });
});
