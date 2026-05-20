import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';
import { TaskEntry } from '../../packages/orchestrator/src/types';

// Minimal engine config so formatReport's registryGet call doesn't throw.
const makeEngine = () => new ConsensusEngine({
  llm: { generate: jest.fn() } as any,
  registryGet: (id: string) => ({ id, provider: 'local', model: 'test', preset: `preset-${id}`, skills: [] }),
} as any);

const makeTask = (agentId: string, result: string): TaskEntry => ({
  id: `task-${agentId}`,
  agentId,
  task: 'review',
  status: 'completed',
  result,
  startedAt: Date.now(),
  completedAt: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
});

// A response that contains ZERO `<agent_finding>` tags — strict parser sees
// no tags at all, falls back to bullet parsing. This drives the rawTagCount===0
// branch where the new zeroTagAgents accumulator lives.
const zeroTagResult = (note: string) => `## Consensus Summary
- Some prose bullet ${note} that has no tagged finding wrapper at all
- Second bullet without any <agent_finding> tag wrapper either
`;

// At least one agent must emit a real tagged finding so the report has SOME
// content; otherwise the report shape (still valid) is fine but we mostly
// want to exercise the accumulator path on the zero-tag agents.
const taggedResult = `<agent_finding type="finding" severity="high">Tagged finding at file.ts:10 for the keeper</agent_finding>`;

describe('ConsensusEngine — zeroTagAgents accumulator', () => {
  it('collects zeroTagAgents for 3 agents that emit no tags, no overflow', async () => {
    const engine = makeEngine();

    const tasks: TaskEntry[] = [
      makeTask('agent-a', zeroTagResult('a')),
      makeTask('agent-b', zeroTagResult('b')),
      makeTask('agent-c', zeroTagResult('c')),
      // One real tagged result so the surrounding round still makes sense
      makeTask('agent-keeper', taggedResult),
    ];

    const report = await engine.synthesize(tasks, []);

    expect(report.zeroTagAgents).toEqual(['agent-a', 'agent-b', 'agent-c']);
    expect(report.zeroTagOverflow).toBeUndefined();
  });

  it('caps zeroTagAgents at 5 entries and counts overflow for the rest', async () => {
    const engine = makeEngine();

    // 7 zero-tag agents → first 5 land in zeroTagAgents, last 2 in zeroTagOverflow.
    const zeroTagIds = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7'];
    const tasks: TaskEntry[] = [
      ...zeroTagIds.map(id => makeTask(id, zeroTagResult(id))),
      makeTask('agent-keeper', taggedResult),
    ];

    const report = await engine.synthesize(tasks, []);

    expect(report.zeroTagAgents).toEqual(['z1', 'z2', 'z3', 'z4', 'z5']);
    expect(report.zeroTagOverflow).toBe(2);
  });

  it('omits both fields entirely when no agent emits zero tags', async () => {
    const engine = makeEngine();

    const tasks: TaskEntry[] = [
      makeTask('agent-a', `<agent_finding type="finding" severity="high">Finding A at a.ts:1 something descriptive</agent_finding>`),
      makeTask('agent-b', `<agent_finding type="finding" severity="low">Finding B at b.ts:2 also descriptive enough</agent_finding>`),
    ];

    const report = await engine.synthesize(tasks, []);

    expect(report.zeroTagAgents).toBeUndefined();
    expect(report.zeroTagOverflow).toBeUndefined();
  });

  it('exactly 5 zero-tag agents — cap full, no overflow', async () => {
    const engine = makeEngine();

    const zeroTagIds = ['z1', 'z2', 'z3', 'z4', 'z5'];
    const tasks: TaskEntry[] = [
      ...zeroTagIds.map(id => makeTask(id, zeroTagResult(id))),
      makeTask('agent-keeper', taggedResult),
    ];

    const report = await engine.synthesize(tasks, []);

    expect(report.zeroTagAgents?.length).toBe(5);
    expect(report.zeroTagOverflow).toBeUndefined();
  });

  it('exactly 6 zero-tag agents — cap full, overflow exactly 1', async () => {
    const engine = makeEngine();

    const zeroTagIds = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6'];
    const tasks: TaskEntry[] = [
      ...zeroTagIds.map(id => makeTask(id, zeroTagResult(id))),
      makeTask('agent-keeper', taggedResult),
    ];

    const report = await engine.synthesize(tasks, []);

    expect(report.zeroTagAgents?.length).toBe(5);
    expect(report.zeroTagOverflow).toBe(1);
  });

  it('mixed round with zero-tag agent and bad-type-tag agent does not cross-contaminate', async () => {
    const engine = makeEngine();

    // Agent A: zero <agent_finding> tags → zeroTagAgents accumulator
    const agentAResult = zeroTagResult('agent-a');

    // Agent B: all findings have wrong type "approval" → droppedFindingsByType accumulator
    const agentBResult = `<agent_finding type="approval">Approval note at file.ts:5 something descriptive enough for the parser</agent_finding>`;

    const tasks: TaskEntry[] = [
      makeTask('agent-a', agentAResult),
      makeTask('agent-b', agentBResult),
      makeTask('agent-keeper', taggedResult),
    ];

    const report = await engine.synthesize(tasks, []);

    // Only agent-a (zero tags) appears in zeroTagAgents
    expect(report.zeroTagAgents).toEqual(['agent-a']);
    // agent-b's "approval" type should land in droppedFindingsByType, not zeroTagAgents
    expect(report.droppedFindingsByType?.['approval']).toBeGreaterThanOrEqual(1);
    expect(report.zeroTagOverflow).toBeUndefined();
  });
});
