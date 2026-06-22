import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { ConsensusEngine, ILLMProvider } from '@gossip/orchestrator';
import { testRound } from '../../packages/orchestrator/src/round-context';

const mockLlm = {
  generate: async () => ({ text: '', toolCalls: [] }),
} as unknown as ILLMProvider;

const mockRegistryGet = () => undefined;

describe('ConsensusEngine.verifyCitations — Unity / Assets paths', () => {
  const testDir = resolve(tmpdir(), 'gossip-unity-citation-' + Date.now());
  const effectSo = resolve(testDir, 'Assets/ForbiddenBrew/Scripts/Runtime/Data/EffectSO.cs');

  beforeAll(() => {
    mkdirSync(resolve(effectSo, '..'), { recursive: true });
    writeFileSync(
      effectSo,
      [
        'namespace ForbiddenBrew {',
        '  public class EffectSO {',
        '    public EffectDef ToDef() => new EffectDef(name, valueModifier);',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  let engine: ConsensusEngine;

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
      round: testRound(),
    });
  });

  test('accepts full Assets path in cite tag', async () => {
    const evidence =
      'Id from asset name <cite tag="file">Assets/ForbiddenBrew/Scripts/Runtime/Data/EffectSO.cs:3</cite>';
    const result = await engine.verifyCitations(evidence, { strict: true });
    expect(result).toBe(false);
  });

  test('accepts full Assets path in prose', async () => {
    const evidence =
      'At Assets/ForbiddenBrew/Scripts/Runtime/Data/EffectSO.cs:3 the ToDef uses name.';
    const result = await engine.verifyCitations(evidence, { strict: true });
    expect(result).toBe(false);
  });

  test('resolves bare EffectSO.cs via Assets search', async () => {
    const evidence = 'EffectSO.cs:3 derives id from name.';
    const result = await engine.verifyCitations(evidence, { strict: true });
    expect(result).toBe(false);
  });

  test('peer-agreed finding with Unity cite promotes to confirmed', async () => {
    const findingText =
      'Effect id from asset name <cite tag="file">Assets/ForbiddenBrew/Scripts/Runtime/Data/EffectSO.cs:3</cite>';
    const results = [
      {
        id: 't1',
        agentId: 'unity-architect',
        task: 'review',
        status: 'completed' as const,
        result: `## Consensus Summary\n<agent_finding type="finding" severity="critical">${findingText}</agent_finding>`,
        startedAt: 0,
        completedAt: 1,
      },
      {
        id: 't2',
        agentId: 'unity-reviewer',
        task: 'review',
        status: 'completed' as const,
        result: '## Consensus Summary\n<agent_finding type="finding" severity="low">Other</agent_finding>',
        startedAt: 0,
        completedAt: 1,
      },
    ];
    const crossReview = [
      {
        action: 'agree' as const,
        agentId: 'unity-reviewer',
        peerAgentId: 'unity-architect',
        finding: 'Effect id from asset name',
        evidence: 'Confirmed at Assets/ForbiddenBrew/Scripts/Runtime/Data/EffectSO.cs:3',
        confidence: 5,
        findingId: 'unity-architect:f1',
      },
    ];
    const report = await engine.synthesize(results, crossReview);
    expect(report.confirmed.length).toBe(1);
    expect(report.confirmed[0].confirmedBy).toContain('unity-reviewer');
    expect(report.unique.filter(f => f.authorFindingId === 'unity-architect:f1')).toHaveLength(0);
  });
});
