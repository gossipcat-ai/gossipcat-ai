/**
 * Gate-OFF test: when `GOSSIP_CONSENSUS_AUTO_VERIFY_UNVERIFIED` is unset or
 * '0', the engine MUST NOT call `verifierDispatch`, MUST NOT stamp any
 * `autoVerify` field, and MUST NOT emit any new signals.
 *
 * Spec: docs/superpowers/specs/2026-05-21-consensus-auto-verify-design.md.
 */
import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';
import { testRound } from '../../packages/orchestrator/src/round-context';
import type { ConsensusFinding, ConsensusSignal } from '../../packages/orchestrator/src/consensus-types';

// Stub LLM provider — never called by maybeAutoVerify (gated off).
const stubLlm: any = {
  generate: jest.fn().mockResolvedValue({ content: '' }),
  generateWithTools: jest.fn().mockResolvedValue({ content: '', toolCalls: [] }),
};

describe('maybeAutoVerify gate-OFF', () => {
  beforeEach(() => {
    delete process.env.GOSSIP_CONSENSUS_AUTO_VERIFY_UNVERIFIED;
    delete process.env.GOSSIP_CONSENSUS_AUTO_VERIFY_AGENT;
  });

  test('flag unset → verifierDispatch is NEVER called, no autoVerify stamps, no new signals', async () => {
    const dispatch = jest.fn().mockResolvedValue('VERDICT: confirmed\nEVIDENCE: ok');
    const engine = new ConsensusEngine({
      llm: stubLlm,
      registryGet: () => undefined,
      projectRoot: process.cwd(),
      verifierDispatch: dispatch,

      round: testRound(),
    });
    const findings: ConsensusFinding[] = [{
      id: 'f1',
      originalAgentId: 'sonnet',
      finding: 'x',
      tag: 'unverified',
      confirmedBy: [],
      disputedBy: [],
      confidence: 3,
    }];
    const signals: ConsensusSignal[] = [];
    // Direct access to the private method via cast — verifying gate-OFF
    // contract without driving a full consensus round.
    const result = await (engine as any).maybeAutoVerify(findings, signals, 'cid', 'seed');
    expect(dispatch).not.toHaveBeenCalled();
    expect(signals).toHaveLength(0);
    expect(result[0].autoVerify).toBeUndefined();
  });

  test('flag = "0" explicitly → same gate-OFF behavior', async () => {
    process.env.GOSSIP_CONSENSUS_AUTO_VERIFY_UNVERIFIED = '0';
    const dispatch = jest.fn().mockResolvedValue('VERDICT: confirmed\nEVIDENCE: ok');
    const engine = new ConsensusEngine({
      llm: stubLlm,
      registryGet: () => undefined,
      projectRoot: process.cwd(),
      verifierDispatch: dispatch,

      round: testRound(),
    });
    const findings: ConsensusFinding[] = [{
      id: 'f1',
      originalAgentId: 's',
      finding: 'x',
      tag: 'unverified',
      confirmedBy: [],
      disputedBy: [],
      confidence: 3,
    }];
    const signals: ConsensusSignal[] = [];
    await (engine as any).maybeAutoVerify(findings, signals, 'cid', 'seed');
    expect(dispatch).not.toHaveBeenCalled();
    expect(signals).toHaveLength(0);
  });

  test('flag = "" empty string explicitly → gate stays OFF (explicit disable)', async () => {
    process.env.GOSSIP_CONSENSUS_AUTO_VERIFY_UNVERIFIED = '';
    const dispatch = jest.fn().mockResolvedValue('VERDICT: confirmed\nEVIDENCE: ok');
    const engine = new ConsensusEngine({
      llm: stubLlm,
      registryGet: () => undefined,
      projectRoot: process.cwd(),
      verifierDispatch: dispatch,

      round: testRound(),
    });
    const signals: ConsensusSignal[] = [];
    await (engine as any).maybeAutoVerify([], signals, 'cid', 'seed');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
