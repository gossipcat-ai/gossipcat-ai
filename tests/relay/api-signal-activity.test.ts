import { signalActivityHandler } from '../../packages/relay/src/dashboard/api-signal-activity';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface SeedRec {
  type?: string;
  signal: string;
  agentId: string;
  counterpartId?: string;
  source?: string;
  timestamp: string;
}

function seed(recs: SeedRec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-test-sig-activity-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  const lines = recs
    .map((r) => JSON.stringify({ type: 'consensus', ...r }))
    .join('\n') + '\n';
  writeFileSync(join(root, '.gossip', 'agent-performance.jsonl'), lines);
  return root;
}

// Writes raw lines verbatim (no JSON wrapping) so tests can inject malformed
// JSONL, blank lines, or records with an explicit non-consensus `type`.
function seedRaw(rawLines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-test-sig-activity-raw-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  writeFileSync(join(root, '.gossip', 'agent-performance.jsonl'), rawLines.join('\n') + '\n');
  return root;
}

const HOUR_MS = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function totalFor(res: { agents: { id: string; buckets: number[] }[] }, id: string): number {
  const a = res.agents.find((x) => x.id === id);
  return a ? a.buckets.reduce((s, n) => s + n, 0) : 0;
}

describe('signalActivityHandler — flat signal log 24h histogram', () => {
  it('counts a MANUAL single-agent signal (the regression)', async () => {
    // A manually-recorded signal: source:"manual", one agentId, no consensus
    // round. The old consensus-runs path (≥2 agents & ≥3 signals) would drop
    // this to zero — it MUST appear here.
    const root = seed([
      { signal: 'unique_confirmed', agentId: 'solo-agent', source: 'manual', timestamp: iso(2 * HOUR_MS) },
    ]);
    const res = await signalActivityHandler(root);
    expect(res.total).toBe(1);
    expect(totalFor(res, 'solo-agent')).toBe(1);
    expect(res.agents.find((a) => a.id === 'solo-agent')?.buckets).toHaveLength(24);
  });

  it('skips _system sentinel and consensus_round_retracted rows', async () => {
    const root = seed([
      { signal: 'agreement', agentId: 'real-agent', timestamp: iso(1 * HOUR_MS) },
      { signal: 'consensus_round_retracted', agentId: '_system', timestamp: iso(1 * HOUR_MS) },
      { signal: 'some_round_signal', agentId: '_system', timestamp: iso(1 * HOUR_MS) },
    ]);
    const res = await signalActivityHandler(root);
    expect(res.total).toBe(1);
    expect(res.agents.map((a) => a.id)).toEqual(['real-agent']);
  });

  it('excludes entries older than the 24h window', async () => {
    const root = seed([
      { signal: 'agreement', agentId: 'old-agent', timestamp: iso(25 * HOUR_MS) },
      { signal: 'agreement', agentId: 'recent-agent', timestamp: iso(1 * HOUR_MS) },
    ]);
    const res = await signalActivityHandler(root);
    expect(res.total).toBe(1);
    expect(res.agents.map((a) => a.id)).toEqual(['recent-agent']);
  });

  it('lands a recent signal in the last bucket (index 23)', async () => {
    // A signal within the current hour falls into the newest bucket.
    const root = seed([
      { signal: 'agreement', agentId: 'now-agent', timestamp: iso(60_000) },
    ]);
    const res = await signalActivityHandler(root);
    const buckets = res.agents.find((a) => a.id === 'now-agent')?.buckets ?? [];
    expect(buckets).toHaveLength(24);
    expect(buckets[23]).toBe(1);
    expect(buckets.slice(0, 23).every((n) => n === 0)).toBe(true);
  });

  it('returns empty shape when the log is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-sig-activity-empty-'));
    const res = await signalActivityHandler(root);
    expect(res.agents).toEqual([]);
    expect(res.total).toBe(0);
    expect(typeof res.generatedAt).toBe('string');
  });

  it('excludes non-consensus type rows (only type==="consensus" counts)', async () => {
    const root = seedRaw([
      JSON.stringify({ type: 'state', signal: 'agreement', agentId: 'state-agent', timestamp: iso(1 * HOUR_MS) }),
      JSON.stringify({ type: 'consensus', signal: 'agreement', agentId: 'real-agent', timestamp: iso(1 * HOUR_MS) }),
    ]);
    const res = await signalActivityHandler(root);
    expect(res.total).toBe(1);
    expect(res.agents.map((a) => a.id)).toEqual(['real-agent']);
  });

  it('skips malformed JSONL lines without throwing', async () => {
    const root = seedRaw([
      '{ this is not valid json',
      '',
      JSON.stringify({ type: 'consensus', signal: 'agreement', agentId: 'good-agent', timestamp: iso(1 * HOUR_MS) }),
    ]);
    const res = await signalActivityHandler(root);
    expect(res.total).toBe(1);
    expect(totalFor(res, 'good-agent')).toBe(1);
  });

  it('excludes future-dated entries (ts > now)', async () => {
    const root = seed([
      // iso(-HOUR_MS) → timestamp one hour in the future.
      { signal: 'agreement', agentId: 'future-agent', timestamp: iso(-1 * HOUR_MS) },
      { signal: 'agreement', agentId: 'recent-agent', timestamp: iso(1 * HOUR_MS) },
    ]);
    const res = await signalActivityHandler(root);
    expect(res.total).toBe(1);
    expect(res.agents.map((a) => a.id)).toEqual(['recent-agent']);
  });

  it('aggregates multiple agents into independent per-agent buckets', async () => {
    const root = seed([
      { signal: 'agreement', agentId: 'agent-a', timestamp: iso(60_000) },       // ~now → bucket 23
      { signal: 'agreement', agentId: 'agent-a', timestamp: iso(60_000) },       // second hit, same bucket
      { signal: 'agreement', agentId: 'agent-b', timestamp: iso(12 * HOUR_MS) }, // ~12h ago → middle bucket
    ]);
    const res = await signalActivityHandler(root);
    expect(res.total).toBe(3);
    expect(totalFor(res, 'agent-a')).toBe(2);
    expect(totalFor(res, 'agent-b')).toBe(1);
    // agent-a concentrated in the newest bucket; agent-b nowhere near it.
    expect(res.agents.find((a) => a.id === 'agent-a')?.buckets[23]).toBe(2);
    expect(res.agents.find((a) => a.id === 'agent-b')?.buckets[23]).toBe(0);
  });

  it('counts a record with counterpartId once (by agentId only — no double count)', async () => {
    const root = seed([
      { signal: 'agreement', agentId: 'primary', counterpartId: 'other', timestamp: iso(1 * HOUR_MS) },
    ]);
    const res = await signalActivityHandler(root);
    expect(res.total).toBe(1);
    expect(totalFor(res, 'primary')).toBe(1);
    // counterpartId must NOT get its own row.
    expect(res.agents.find((a) => a.id === 'other')).toBeUndefined();
  });
});
