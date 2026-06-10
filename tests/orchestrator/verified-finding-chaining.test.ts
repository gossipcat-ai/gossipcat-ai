import { getRuntimeFlagBool } from '../../packages/orchestrator/src/runtime-config';
import { RUNTIME_FLAG_REGISTRY } from '../../packages/orchestrator/src/runtime-config-schema';
import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';
import { TaskEntry } from '../../packages/orchestrator/src/types';

const makeTask = (agentId: string, result: string): TaskEntry => ({
  id: `task-${agentId}`, agentId, task: 'review', status: 'completed', result,
  startedAt: 1, completedAt: 2, inputTokens: 0, outputTokens: 0,
});

const engine = () => new ConsensusEngine({} as any);

describe('GOSSIP_VERIFIED_CHAINING flag', () => {
  it('is registered and defaults to off', () => {
    expect(RUNTIME_FLAG_REGISTRY).toHaveProperty('GOSSIP_VERIFIED_CHAINING');
    // default '0' → false when env unset
    delete process.env.GOSSIP_VERIFIED_CHAINING;
    expect(getRuntimeFlagBool('GOSSIP_VERIFIED_CHAINING')).toBe(false);
  });
});

describe('parseCrossReviewResponse — chaining fields', () => {
  it('captures parentFindingId and a valid severity on a NEW entry', () => {
    const json = JSON.stringify([
      { action: 'new', findingId: 'self:n1', finding: 'reachable unauth via routes.ts:88',
        evidence: 'see routes.ts:88', confidence: 4,
        parentFindingId: 'gemini-reviewer:f1', severity: 'critical' },
    ]);
    const entries = (engine() as any).parseCrossReviewResponse('sonnet-reviewer', json, 50);
    expect(entries).toHaveLength(1);
    expect(entries[0].parentFindingId).toBe('gemini-reviewer:f1');
    expect(entries[0].severity).toBe('critical');
  });

  it('drops an invalid severity to undefined but keeps the entry', () => {
    const json = JSON.stringify([
      { action: 'new', findingId: 'self:n1', finding: 'x', evidence: 'y', confidence: 3,
        parentFindingId: 'gemini-reviewer:f2', severity: 'catastrophic' },
    ]);
    const entries = (engine() as any).parseCrossReviewResponse('sonnet-reviewer', json, 50);
    expect(entries).toHaveLength(1);
    expect(entries[0].severity).toBeUndefined();
    expect(entries[0].parentFindingId).toBe('gemini-reviewer:f2');
  });
});

describe('synthesize — NEW entry verification + field carry', () => {
  it('carries parentFindingId + severity onto the newFindings entry', async () => {
    const eng = new ConsensusEngine({
      llm: { generate: jest.fn() } as any,
      registryGet: (id: string) => ({ id, provider: 'local', model: 'test', preset: id, skills: [] }),
    } as any);
    const results = [makeTask('a', 'x'), makeTask('b', 'y')];
    const entries = [{
      action: 'new' as const, agentId: 'b', peerAgentId: '',
      findingId: 'cid:new:b:1', finding: 'auth bypass at routes.ts:88',
      evidence: 'routes.ts:88 lacks guard', confidence: 4,
      parentFindingId: 'a:f1', severity: 'critical' as const,
    }];
    const report = await (eng as any).synthesize(results, entries, 'cid12345-67890abc');
    expect(report.newFindings).toHaveLength(1);
    expect(report.newFindings[0].parentFindingId).toBe('a:f1');
    expect(report.newFindings[0].severity).toBe('critical');
  });

  it('drops a NEW entry whose citation is fabricated', async () => {
    const eng = new ConsensusEngine({
      llm: { generate: jest.fn() } as any,
      registryGet: (id: string) => ({ id, provider: 'local', model: 'test', preset: id, skills: [] }),
    } as any);
    (eng as any).verifyCitations = jest.fn().mockResolvedValue(true);
    const results = [makeTask('a', 'x'), makeTask('b', 'y')];
    const entries = [{
      action: 'new' as const, agentId: 'b', peerAgentId: '',
      findingId: 'cid:new:b:1', finding: 'bug at nonexistent.ts:999',
      evidence: 'nonexistent.ts:999', confidence: 5, parentFindingId: 'a:f1',
    }];
    const report = await (eng as any).synthesize(results, entries, 'cid12345-67890abc');
    expect(report.newFindings).toHaveLength(0);
  });
});
