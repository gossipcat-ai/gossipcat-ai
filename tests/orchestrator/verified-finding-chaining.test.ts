import { getRuntimeFlagBool } from '../../packages/orchestrator/src/runtime-config';
import { RUNTIME_FLAG_REGISTRY } from '../../packages/orchestrator/src/runtime-config-schema';
import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';

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
