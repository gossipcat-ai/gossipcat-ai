// tests/orchestrator/consensus-memory-directive.test.ts
//
// Issue #659: the Phase-2 cross-review system prompt never directed memory
// recall, even though the tool is reachable (`memory_query` in VERIFIER_TOOLS
// for engine-driven reviewers, `mcp__gossipcat__gossip_remember` for native
// ones). These tests pin the verification-scoped directive AND its
// anti-anchoring guardrail — the guardrail is the load-bearing half, so it is
// asserted independently of the permission clause.
import {
  ConsensusEngine,
  ConsensusEngineConfig,
  CROSS_REVIEW_MEMORY_DIRECTIVE,
} from '../../packages/orchestrator/src/consensus-engine';
import { testRound } from '../../packages/orchestrator/src/round-context';
import { AgentConfig, TaskEntry } from '../../packages/orchestrator/src/types';
import { ILLMProvider } from '../../packages/orchestrator/src/llm-client';

const mockLlm: jest.Mocked<ILLMProvider> = { generate: jest.fn() };

const mockRegistryGet = jest.fn((agentId: string): AgentConfig | undefined => ({
  id: agentId,
  provider: 'local',
  model: 'test-model',
  preset: `preset-for-${agentId}`,
  skills: [],
}));

const baseConfig: ConsensusEngineConfig = {
  llm: mockLlm,
  registryGet: mockRegistryGet,
  round: testRound(),
};

const createTaskEntry = (agentId: string, result: string): TaskEntry => ({
  id: `task-${agentId}`,
  agentId,
  task: 'review the code',
  status: 'completed',
  result,
  startedAt: Date.now(),
  completedAt: Date.now(),
  inputTokens: 100,
  outputTokens: 200,
});

const twoAgents = (): TaskEntry[] => [
  createTaskEntry('agent-a', '## Consensus Summary\n- Finding A at file.ts:10\n- Finding A2 at file.ts:11'),
  createTaskEntry('agent-b', '## Consensus Summary\n- Finding B at other.ts:20\n- Finding B2 at other.ts:21'),
];

async function systemPrompts(config: ConsensusEngineConfig = baseConfig): Promise<string[]> {
  const engine = new ConsensusEngine({ ...config, round: testRound() });
  const { prompts } = await engine.generateCrossReviewPrompts(twoAgents());
  expect(prompts.length).toBeGreaterThan(0);
  return prompts.map(p => p.system);
}

describe('cross-review memory directive (#659)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('injects the verification-scoped memory directive into every cross-review system prompt', async () => {
    for (const system of await systemPrompts()) {
      expect(system).toContain(CROSS_REVIEW_MEMORY_DIRECTIVE);
      expect(system).toContain('MEMORY (optional, verification-scoped)');
      expect(system).toContain('ALLOWED: process memory only');
    }
  });

  it('injects the directive even when no skills block is available', async () => {
    // The four production ConsensusEngine construction sites outside
    // consensus-coordinator.ts do NOT pass getAgentSkillsContent, so the
    // skills block is empty there. The directive must not depend on it.
    for (const system of await systemPrompts()) {
      expect(system).not.toContain('--- SKILLS ---');
      expect(system).toContain(CROSS_REVIEW_MEMORY_DIRECTIVE);
    }
  });

  it('states the FORBIDDEN anti-anchoring clause, not just the recall permission', async () => {
    for (const system of await systemPrompts()) {
      expect(system).toContain('FORBIDDEN: substituting a recalled verdict for fresh verification');
      expect(system).toContain('A recalled verdict is NOT evidence');
      expect(system).toContain('must NEVER produce an AGREE');
      expect(system).toContain('Re-verify every round.');
    }
  });

  it('places the guardrail after the "false confirmation poisons the system" rule it reinforces', async () => {
    for (const system of await systemPrompts()) {
      const poisonIdx = system.indexOf('a false confirmation poisons the system');
      const forbiddenIdx = system.indexOf('FORBIDDEN: substituting a recalled verdict');
      expect(poisonIdx).toBeGreaterThan(-1);
      expect(forbiddenIdx).toBeGreaterThan(poisonIdx);
    }
  });

  it('requires traceable memory-informed verdicts using the existing citation convention', async () => {
    for (const system of await systemPrompts()) {
      expect(system).toContain('per gossip_remember finding <id>');
    }
  });

  it('names the recall tool conditionally so a relay reviewer is never told to call a native-only tool', async () => {
    for (const system of await systemPrompts()) {
      // Both tool names appear, each gated on the reader's runtime — mirroring
      // default-skills/memory-retrieval.md. Neither is stated unconditionally.
      expect(system).toContain('`memory_query(query)` if your Identity block says `runtime: relay`');
      expect(system).toContain('`gossip_remember(agent_id, query)` if `runtime: native`');
    }
  });

  it('is tight enough to pay for on every cross-review call', () => {
    // Budget guard: this block ships on every agent's Phase-2 prompt in every
    // round. A regression that grows it into an essay should fail loudly.
    expect(CROSS_REVIEW_MEMORY_DIRECTIVE.length).toBeLessThan(1000);
  });

  it('leaves the pre-existing verification rules intact', async () => {
    for (const system of await systemPrompts()) {
      expect(system).toContain('VERIFICATION RULES:');
      expect(system).toContain('AGREE only if you can confirm the claim is factually correct — cite your evidence');
      expect(system).toContain('DISAGREE only if you have concrete evidence the finding is WRONG — the code contradicts the claim');
      expect(system).toContain('UNVERIFIED only as a last resort after attempting tool-based verification');
      expect(system).toContain('Do NOT agree with a finding just because it sounds plausible — verify it');
      expect(system).toContain('Agreeing without verification is WORSE than disagreeing');
      expect(system).toContain('If a finding has an <anchor> block, use the code shown to verify the claim');
      expect(system).toContain('SOURCE FILES: Always cite original source files');
      expect(system).toContain('Return only valid JSON.');
    }
  });

  it('keeps "Return only valid JSON." as the final instruction before any skills block', async () => {
    const [system] = await systemPrompts({
      ...baseConfig,
      getAgentSkillsContent: () => 'SKILL BODY',
    });
    expect(system).toContain('--- SKILLS ---');
    // Directive sits above the JSON contract; the skills block stays last.
    expect(system.indexOf(CROSS_REVIEW_MEMORY_DIRECTIVE))
      .toBeLessThan(system.indexOf('Return only valid JSON.'));
    expect(system.indexOf('Return only valid JSON.'))
      .toBeLessThan(system.indexOf('--- SKILLS ---'));
  });
});
