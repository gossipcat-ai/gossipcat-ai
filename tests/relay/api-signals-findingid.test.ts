import { signalsHandler } from '../../packages/relay/src/dashboard/api-signals';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('signalsHandler findingId/consensusId pass-through', () => {
  it('surfaces findingId, consensusId, severity on returned items', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-signals-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const rec = {
      type: 'consensus',
      signal: 'agreement',
      agentId: 'sonnet-reviewer',
      counterpartId: 'gemini-reviewer',
      taskId: '81e580b2',
      consensusId: 'd07eac46-5f464e89',
      findingId: 'd07eac46-5f464e89:sonnet-reviewer:f1',
      severity: 'high',
      evidence: 'race condition confirmed',
      timestamp: '2026-04-17T10:00:00.000Z',
    };
    writeFileSync(join(root, '.gossip', 'agent-performance.jsonl'), JSON.stringify(rec) + '\n');
    const res = await signalsHandler(root);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].findingId).toBe('d07eac46-5f464e89:sonnet-reviewer:f1');
    expect(res.items[0].consensusId).toBe('d07eac46-5f464e89');
    expect(res.items[0].severity).toBe('high');
  });
});
