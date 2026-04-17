import { consensusHandler } from '@gossip/relay/dashboard/api-consensus';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('consensusHandler retraction annotation', () => {
  it('marks retracted runs and exposes retractedConsensusIds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-cret-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });

    const run1Sigs = Array.from({ length: 3 }, (_, i) => ({
      type: 'consensus', taskId: 't1', consensusId: 'aaa-bbb',
      signal: 'agreement', agentId: `agent-${i % 2 ? 'a' : 'b'}`,
      counterpartId: `agent-${i % 2 ? 'b' : 'a'}`,
      findingId: `aaa-bbb:f${i}`,
      timestamp: `2026-04-17T10:0${i}:00Z`,
    }));
    const run2Sigs = Array.from({ length: 3 }, (_, i) => ({
      type: 'consensus', taskId: 't2', consensusId: 'ccc-ddd',
      signal: 'agreement', agentId: `agent-${i % 2 ? 'a' : 'b'}`,
      counterpartId: `agent-${i % 2 ? 'b' : 'a'}`,
      findingId: `ccc-ddd:f${i}`,
      timestamp: `2026-04-17T11:0${i}:00Z`,
    }));
    const retract = {
      type: 'consensus', signal: 'consensus_round_retracted',
      agentId: '_system', consensus_id: 'aaa-bbb',
      reason: 'reviewed wrong branch',
      retracted_at: '2026-04-17T12:00:00Z',
      timestamp: '2026-04-17T12:00:00Z',
    };

    writeFileSync(
      join(root, '.gossip', 'agent-performance.jsonl'),
      [...run1Sigs, ...run2Sigs, retract].map(r => JSON.stringify(r)).join('\n') + '\n',
    );

    const res = await consensusHandler(root);
    expect(res.retractedConsensusIds).toContain('aaa-bbb');
    expect(res.retractedConsensusIds).not.toContain('ccc-ddd');
    const retracted = res.runs.find(r => r.taskId === 'aaa-bbb');
    const live = res.runs.find(r => r.taskId === 'ccc-ddd');
    expect(retracted?.retracted).toBe(true);
    expect(retracted?.retractionReason).toBe('reviewed wrong branch');
    expect(live?.retracted).toBeFalsy();
  });

  it('returns empty retractedConsensusIds when no retractions exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-cret-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    writeFileSync(join(root, '.gossip', 'agent-performance.jsonl'), '');
    const res = await consensusHandler(root);
    expect(res.retractedConsensusIds ?? []).toEqual([]);
    expect(res.runs).toEqual([]);
  });
});
