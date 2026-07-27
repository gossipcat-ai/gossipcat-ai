// tests/cli/collect-cross-review-skill-gate.test.ts
//
// Issue #666: severity-conditional cross-review skill injection on the
// gossip_collect path. handleCollect composes the exact seam exercised here —
// `buildGatedCrossReviewSkillsResolver(...)` spread into the `ConsensusEngine`
// config it constructs — so these tests drive the production builder into a
// real engine and assert on the emitted Phase-2 system prompt.
//
// The load-bearing guarantee is the NEGATIVE one: when the gate is closed the
// prompt must be byte-identical to a round with no skill wiring at all, so the
// ~43KB/agent/round cost is never paid on a medium/low round.
import { buildGatedCrossReviewSkillsResolver } from '../../apps/cli/src/handlers/cross-review-skill-gate';
import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';
import { testRound } from '../../packages/orchestrator/src/round-context';
import { AgentConfig, TaskEntry } from '../../packages/orchestrator/src/types';
import { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SKILL_MARKER = 'CROSS_REVIEW_SKILL_MARKER_666';

const mockLlm: jest.Mocked<ILLMProvider> = { generate: jest.fn() };

const registryGet = (agentId: string): AgentConfig => ({
  id: agentId,
  provider: 'local',
  model: 'test-model',
  skills: ['gate-lens'],
});

const finding = (severity: string, text: string): string =>
  `<agent_finding type="finding" severity="${severity}">${text}</agent_finding>`;

const taskEntry = (agentId: string, result: string): TaskEntry => ({
  id: `task-${agentId}`,
  agentId,
  task: 'review the collect path',
  status: 'completed',
  result,
  startedAt: Date.now(),
  completedAt: Date.now(),
  inputTokens: 10,
  outputTokens: 20,
});

describe('gossip_collect cross-review skill gate (#666)', () => {
  let tmp: string;
  const logLines: string[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'collect-gate-'));
    for (const agentId of ['agent-a', 'agent-b']) {
      const dir = join(tmp, '.gossip', 'agents', agentId, 'skills');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'gate-lens.md'), `# Gate Lens\n${SKILL_MARKER}\n`);
    }
    logLines.length = 0;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const build = (results: TaskEntry[]) =>
    buildGatedCrossReviewSkillsResolver({
      results,
      registryGet,
      projectRoot: tmp,
      log: (line) => { logLines.push(line); },
    });

  const systemPrompts = async (
    results: TaskEntry[],
    getAgentSkillsContent?: (agentId: string, task: string) => string | undefined,
  ): Promise<string[]> => {
    const engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet,
      round: testRound(),
      ...(getAgentSkillsContent ? { getAgentSkillsContent } : {}),
    });
    const { prompts } = await engine.generateCrossReviewPrompts(results);
    expect(prompts.length).toBeGreaterThan(0);
    return prompts.map(p => p.system);
  };

  const criticalRound = (): TaskEntry[] => [
    taskEntry('agent-a', finding('critical', 'Unvalidated path reaches disk at src/a.ts:10')),
    taskEntry('agent-b', finding('low', 'Naming nit in the helper at src/b.ts:20')),
  ];

  const highRound = (): TaskEntry[] => [
    taskEntry('agent-a', finding('high', 'Missing bounds check at src/a.ts:11')),
    taskEntry('agent-b', finding('medium', 'Duplicated branch at src/b.ts:21')),
  ];

  const lowRound = (): TaskEntry[] => [
    taskEntry('agent-a', finding('medium', 'Duplicated branch at src/a.ts:12')),
    taskEntry('agent-b', finding('low', 'Naming nit in the helper at src/b.ts:22')),
  ];

  it('injects each reviewer\'s skills into the Phase-2 prompt on a critical round', async () => {
    const resolver = build(criticalRound());
    expect(resolver).toBeDefined();
    for (const system of await systemPrompts(criticalRound(), resolver)) {
      expect(system).toContain('--- SKILLS ---');
      expect(system).toContain(SKILL_MARKER);
    }
  });

  it('injects skills on a high round', async () => {
    const resolver = build(highRound());
    expect(resolver).toBeDefined();
    for (const system of await systemPrompts(highRound(), resolver)) {
      expect(system).toContain(SKILL_MARKER);
    }
  });

  it('leaves the ungated (medium/low) prompt byte-identical to the no-skills baseline', async () => {
    const resolver = build(lowRound());
    expect(resolver).toBeUndefined();

    const gated = await systemPrompts(lowRound(), resolver);
    const baseline = await systemPrompts(lowRound());
    expect(gated).toEqual(baseline);
    for (const system of gated) {
      expect(system).not.toContain('--- SKILLS ---');
      expect(system).not.toContain(SKILL_MARKER);
    }
  });

  it('stays closed when no agent emitted a parseable finding', () => {
    expect(build([
      taskEntry('agent-a', 'Prose summary with no schema tags at all.'),
      taskEntry('agent-b', ''),
    ])).toBeUndefined();
  });

  it('ignores severities on results that never completed', () => {
    const running: TaskEntry = {
      ...taskEntry('agent-a', finding('critical', 'Unvalidated path reaches disk at src/a.ts:10')),
      status: 'running',
    };
    expect(build([running, taskEntry('agent-b', finding('low', 'Naming nit at src/b.ts:20'))])).toBeUndefined();
  });

  it('ignores a non-string result payload instead of throwing', () => {
    const malformed = { status: 'completed', result: { severity: 'critical' } };
    expect(buildGatedCrossReviewSkillsResolver({
      results: [malformed],
      registryGet,
      projectRoot: tmp,
      log: (line) => { logLines.push(line); },
    })).toBeUndefined();
  });

  it('logs one auditable line naming the verdict and the triggering severity', () => {
    build(criticalRound());
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('cross-review skills_injected: true');
    expect(logLines[0]).toContain('severity_gate=critical');

    logLines.length = 0;
    build(lowRound());
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('cross-review skills_injected: false');
    expect(logLines[0]).toContain('severity_gate=none');
  });
});
