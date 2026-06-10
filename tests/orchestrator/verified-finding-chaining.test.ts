import { getRuntimeFlagBool } from '../../packages/orchestrator/src/runtime-config';
import { RUNTIME_FLAG_REGISTRY } from '../../packages/orchestrator/src/runtime-config-schema';

describe('GOSSIP_VERIFIED_CHAINING flag', () => {
  it('is registered and defaults to off', () => {
    expect(RUNTIME_FLAG_REGISTRY).toHaveProperty('GOSSIP_VERIFIED_CHAINING');
    // default '0' → false when env unset
    delete process.env.GOSSIP_VERIFIED_CHAINING;
    expect(getRuntimeFlagBool('GOSSIP_VERIFIED_CHAINING')).toBe(false);
  });
});
