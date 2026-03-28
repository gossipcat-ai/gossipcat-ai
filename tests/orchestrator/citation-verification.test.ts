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

  test('detects fabricated citation — claims throw that does not exist', async () => {
    const evidence =
      'The code at task-dispatcher.ts:14 explicitly throws an error if no agent is available. ' +
      'This prevents a task from being dispatched to a null agent.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(true); // fabricated — line 14 is "if (match) {", no throw
  });

  test('accepts valid citation — code matches claim', async () => {
    const evidence =
      'The code at task-dispatcher.ts:17 pushes a warning when no agent is found. ' +
      'This is just a warning, not a guard.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(false); // valid — line 17 does push a warning
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

  test('handles multiple citations — fails if any is fabricated', async () => {
    const evidence =
      'The code at task-dispatcher.ts:13 calls findBestMatch which validates input, ' +
      'and task-dispatcher.ts:14 explicitly throws an error to prevent invalid dispatch.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(true); // line 14 doesn't throw
  });

  test('handles citation with full path', async () => {
    const evidence =
      'At packages/orchestrator/src/task-dispatcher.ts:14 the code explicitly throws an error.';

    const result = await engine.verifyCitations(evidence);
    expect(result).toBe(true); // fabricated — no throw at line 14
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

  test('fabricated dispute does not suppress a valid finding', async () => {
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
        evidence: 'The code at task-dispatcher.ts:3 explicitly throws an error if no agent is available.',
        confidence: 4,
      },
    ];

    const report = await engine.synthesize(results, crossReviewEntries);

    // The finding should NOT be tagged as disputed — the dispute was fabricated
    const finding = report.confirmed.find(f => f.finding.includes('Empty agentId'))
      || report.unique.find(f => f.finding.includes('Empty agentId'));

    expect(finding).toBeDefined();
    expect(report.disputed.find(f => f.finding.includes('Empty agentId'))).toBeUndefined();

    // Should emit a hallucination_caught signal with fabricated_citation outcome
    const hallucinationSignal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.outcome === 'fabricated_citation',
    );
    expect(hallucinationSignal).toBeDefined();
    expect(hallucinationSignal!.counterpartId).toBe('agent-b');
  });
});

describe('ConsensusEngine.verifyNegativeClaim — false negative detection', () => {
  const testDir = resolve(tmpdir(), 'gossip-negclaim-test-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    // File that HAS validation
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/skill-generator.ts'),
      [
        'export class SkillGenerator {',
        '  async generate(agentId: string, category: string) {',
        '    if (!SAFE_NAME.test(agentId)) {',
        '      throw new Error("Invalid agent_id");',
        '    }',
        '    if (!KNOWN_CATEGORIES.has(category)) {',
        '      throw new Error("Unknown category");',
        '    }',
        '    // validation passed, proceed',
        '    const template = this.loadTemplate();',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  test('detects false negative claim — says no validation but validation exists', async () => {
    const finding = 'No validation on agent_id and category parameters (skill-generator.ts:2)';
    const result = await engine.verifyNegativeClaim(finding);
    expect(result).toBe(true); // claim is false — validation exists
  });

  test('accepts true negative claim — code genuinely lacks the feature', async () => {
    const finding = 'No authentication on relay connection (nonexistent-file.ts:10)';
    const result = await engine.verifyNegativeClaim(finding);
    expect(result).toBe(false); // can't find the file, so can't disprove the claim
  });

  test('ignores findings without negative claims', async () => {
    const finding = 'The sanitization at consensus-engine.ts:87 strips data tags';
    const result = await engine.verifyNegativeClaim(finding);
    expect(result).toBe(false); // no negative claim detected
  });

  test('mass-agreed false finding gets demoted from confirmed to unique', async () => {
    const results = [
      { id: 'task-1', agentId: 'agent-a', task: 'review', status: 'completed' as const, result: '## Consensus Summary\n- No validation on inputs (skill-generator.ts:2)', startedAt: Date.now() },
      { id: 'task-2', agentId: 'agent-b', task: 'review', status: 'completed' as const, result: '## Consensus Summary\n- Other finding', startedAt: Date.now() },
    ];

    const crossReviewEntries = [
      {
        action: 'agree' as const,
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        finding: 'No validation on inputs (skill-generator.ts:2)',
        evidence: 'I confirm there is no validation on the inputs.',
        confidence: 4,
      },
    ];

    const report = await engine.synthesize(results, crossReviewEntries);

    // The false finding should NOT be confirmed
    expect(report.confirmed.find(f => f.finding.includes('No validation'))).toBeUndefined();

    // It should be demoted to unique
    expect(report.unique.find(f => f.finding.includes('No validation'))).toBeDefined();

    // Should emit hallucination signal
    const hallucinationSignal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.outcome === 'false_negative_claim',
    );
    expect(hallucinationSignal).toBeDefined();
  });
});
