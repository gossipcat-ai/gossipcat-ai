import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';
import { testRound } from '../../packages/orchestrator/src/round-context';

describe('verifyCitations — I/O error handling', () => {
  it('returns false on I/O read error (benefit of doubt)', async () => {
    const engine = new ConsensusEngine({
      llm: { generate: async () => '' } as any,
      registryGet: () => undefined,
      projectRoot: '/nonexistent/path/that/triggers/io/error',

      round: testRound(),
    });
    const result = await (engine as any).verifyCitations('Found bug at real-file.ts:999');
    expect(result).toBe(false);
  });
});
