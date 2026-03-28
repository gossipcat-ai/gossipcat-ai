import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { ConsensusEngine, ILLMProvider } from '@gossip/orchestrator';

// Minimal mock LLM — not used by verifyCitations
const mockLlm = {
  generate: async () => ({ text: '', toolCalls: [] }),
} as unknown as ILLMProvider;

const mockRegistryGet = () => undefined;

describe('ConsensusEngine.verifyCitations', () => {
  const testDir = resolve(tmpdir(), 'gossip-citation-test-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    // Create a fake project structure
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/task-dispatcher.ts'),
      [
        'import { randomUUID } from "crypto";',              // line 1
        '',                                                    // line 2
        'export class TaskDispatcher {',                      // line 3
        '  constructor(private registry: AgentRegistry) {}',  // line 4
        '',                                                    // line 5
        '  async decompose(task: string) {',                  // line 6
        '    const plan = await this.llm.generate(messages);', // line 7
        '    return plan;',                                    // line 8
        '  }',                                                // line 9
        '',                                                    // line 10
        '  assignAgents(plan: DispatchPlan) {',               // line 11
        '    for (const subTask of plan.subTasks) {',         // line 12
        '      const match = this.registry.findBestMatch(subTask.requiredSkills);', // line 13
        '      if (match) {',                                 // line 14
        '        subTask.assignedAgent = match.id;',          // line 15
        '      } else {',                                     // line 16
        '        plan.warnings.push("no agent found");',      // line 17
        '      }',                                            // line 18
        '    }',                                               // line 19
        '    return plan;',                                    // line 20
        '  }',                                                // line 21
        '}',                                                   // line 22
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  test('accepts citation when file and line exist (structural check only)', async () => {
    // verifyCitations now only checks structural validity (file exists, line in range)
    // Behavioral claim verification is handled by ConsensusJudge
    const evidence =
      'The code at task-dispatcher.ts:14 explicitly throws an error if no agent is available.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // file exists, line in range → structurally valid
  });

  test('accepts valid citation — file and line exist', async () => {
    const evidence =
      'The code at task-dispatcher.ts:17 pushes a warning when no agent is found.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // file exists, line in range → structurally valid
  });

  test('detects fabricated citation — file does not exist', async () => {
    const evidence =
      'The code at nonexistent-file.ts:10 validates the input thoroughly.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(true); // fabricated — file doesn't exist
  });

  test('detects fabricated citation — line beyond file length', async () => {
    const evidence =
      'The code at task-dispatcher.ts:500 throws an error for invalid tasks.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(true); // fabricated — file only has 22 lines
  });

  test('returns false when no citations in evidence', async () => {
    const evidence =
      'I disagree because the logic is fundamentally flawed and does not handle edge cases.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // no citations to verify
  });

  test('returns false when no projectRoot configured', async () => {
    const engineNoRoot = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      // no projectRoot
    });

    const evidence = 'The code at task-dispatcher.ts:14 explicitly throws an error.';
    const result = await engineNoRoot.verifyCitations(evidence);
    expect(result).toBe(false); // can't verify without projectRoot
  });

  test('handles multiple citations — all exist structurally', async () => {
    const evidence =
      'The code at task-dispatcher.ts:13 calls findBestMatch which validates input, ' +
      'and task-dispatcher.ts:14 handles the result.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // both lines exist in file → structurally valid
  });

  test('handles citation with full path', async () => {
    const evidence =
      'At packages/orchestrator/src/task-dispatcher.ts:14 the code handles agent assignment.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // file exists at full path, line in range
  });
});

describe('ConsensusEngine.synthesize — citation verification integration', () => {
  const testDir = resolve(tmpdir(), 'gossip-synth-citation-test-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/task-dispatcher.ts'),
      [
        'export class TaskDispatcher {',
        '  assignAgents(plan: DispatchPlan) {',
        '    if (match) {',
        '      subTask.assignedAgent = match.id;',
        '    } else {',
        '      plan.warnings.push("no agent");',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  test('fabricated dispute citing non-existent file does not suppress valid finding', async () => {
    const results = [
      { id: 'task-1', agentId: 'agent-a', task: 'review', status: 'completed' as const, result: '## Consensus Summary\n- Empty agentId allows invalid dispatch', startedAt: Date.now() },
      { id: 'task-2', agentId: 'agent-b', task: 'review', status: 'completed' as const, result: '## Consensus Summary\n- Some other finding', startedAt: Date.now() },
    ];

    const crossReviewEntries = [
      {
        action: 'disagree' as const,
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        finding: 'Empty agentId allows invalid dispatch',
        evidence: 'The code at nonexistent-module.ts:3 explicitly throws an error.',
        confidence: 4,
      },
    ];

    const report = await engine.synthesize(results, crossReviewEntries);

    // The finding should NOT be tagged as disputed — the dispute cites a non-existent file
    const finding = report.confirmed.find(f => f.finding.includes('Empty agentId'))
      || report.unique.find(f => f.finding.includes('Empty agentId'));

    expect(finding).toBeDefined();
    expect(report.disputed.find(f => f.finding.includes('Empty agentId'))).toBeUndefined();

    // Should emit a hallucination_caught signal
    const hallucinationSignal = report.signals.find(
      s => s.signal === 'hallucination_caught',
    );
    expect(hallucinationSignal).toBeDefined();
  });
});

// verifyNegativeClaim tests removed — replaced by ConsensusJudge (consensus-judge.test.ts)
// verifyCitations on confirmed findings is tested via the synthesize integration test above
