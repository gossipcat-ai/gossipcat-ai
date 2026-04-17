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
});
