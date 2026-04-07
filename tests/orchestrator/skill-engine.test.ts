import { SkillEngine, PerformanceReader, ILLMProvider } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const VALID_SKILL = `---
name: injection-audit
category: injection_vectors
agent: agent-a
generated: 2026-03-28T00:00:00Z
effectiveness: 0.0
baseline_rate: 0.1
baseline_dispatches: 10
post_skill_dispatches: 0
version: 1
mode: contextual
keywords: [injection, xss, sql, sanitize]
---

# Injection Audit

## Iron Law

NO input path assessment without tracing from entry point to LLM prompt.

## When This Skill Activates

- Task mentions injection, sanitization, prompt construction

## Methodology

1. Map all entry points
2. Trace each input path
3. Check sanitization at boundaries

## Key Patterns

- Check for raw string interpolation

## Anti-Patterns

| Thought | Reality |
|---------|---------|
| "It's wrapped in tags" | Tags are advisory |

## Quality Gate

- [ ] Each finding cites file:line
`;

function mockLLM(text: string): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text }),
  };
}

function writeSignals(dir: string, signals: object[]): void {
  const data = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
  writeFileSync(join(dir, '.gossip', 'agent-performance.jsonl'), data);
}

function seedTestData(dir: string): void {
  const signals: object[] = [];
  // 12 task_completed signals for agent-a
  for (let i = 0; i < 12; i++) {
    signals.push({
      type: 'meta', signal: 'task_completed', agentId: 'agent-a',
      taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z',
    });
  }
  // 1 category_confirmed for injection_vectors for agent-a
  signals.push({
    type: 'consensus', signal: 'category_confirmed', agentId: 'agent-a',
    category: 'injection_vectors', evidence: 'Found unsanitized user input in prompt',
    taskId: 't0', timestamp: '2026-01-01T00:00:00Z',
  });
  // peer-b with 5 category_confirmed signals
  for (let i = 0; i < 5; i++) {
    signals.push({
      type: 'consensus', signal: 'category_confirmed', agentId: 'peer-b',
      category: 'injection_vectors', evidence: `Peer finding ${i}`,
      taskId: `tp${i}`, timestamp: '2026-01-01T00:00:00Z',
    });
  }
  // task_completed for peer-b so profiler can compute
  for (let i = 0; i < 5; i++) {
    signals.push({
      type: 'meta', signal: 'task_completed', agentId: 'peer-b',
      taskId: `tp${i}`, value: 2000, timestamp: '2026-01-01T00:00:00Z',
    });
  }
  writeSignals(dir, signals);
  // bootstrap.md
  writeFileSync(join(dir, '.gossip', 'bootstrap.md'), '# Test Project\n');
}

describe('SkillEngine', () => {
  const testDir = join(tmpdir(), 'gossip-skillgen-' + Date.now());

  beforeAll(() => {
    mkdirSync(join(testDir, '.gossip'), { recursive: true });
    seedTestData(testDir);
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  test('rejects unknown category', async () => {
    const gen = new SkillEngine(mockLLM(''), new PerformanceReader(testDir), testDir);
    await expect(gen.generate('agent-a', 'unknown_cat')).rejects.toThrow('Unknown category');
  });

  test('rejects agent_id with path traversal', async () => {
    const gen = new SkillEngine(mockLLM(''), new PerformanceReader(testDir), testDir);
    await expect(gen.generate('../evil', 'injection_vectors')).rejects.toThrow('Invalid agent_id');
  });

  test('rejects agent_id with uppercase', async () => {
    const gen = new SkillEngine(mockLLM(''), new PerformanceReader(testDir), testDir);
    await expect(gen.generate('Agent-A', 'injection_vectors')).rejects.toThrow('Invalid agent_id');
  });

  test('generates skill with valid frontmatter and all required sections', async () => {
    const llm = mockLLM(VALID_SKILL);
    const gen = new SkillEngine(llm, new PerformanceReader(testDir), testDir);
    const result = await gen.generate('agent-a', 'injection_vectors');

    expect(result.content).toContain('## Iron Law');
    expect(result.content).toContain('## Methodology');
    expect(result.content).toContain('## Anti-Patterns');
    expect(result.content).toContain('## Quality Gate');
    expect(result.content).toContain('name: injection-audit');
    expect(result.path).toContain('agent-a/skills/injection-vectors.md');
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, 'utf-8')).toBe(VALID_SKILL.trim());
  });

  test('rejects LLM output missing required sections', async () => {
    const badContent = `---
name: test
---

# Test

## Iron Law

Do stuff.
`;
    const gen = new SkillEngine(mockLLM(badContent), new PerformanceReader(testDir), testDir);
    await expect(gen.generate('agent-a', 'injection_vectors')).rejects.toThrow('missing required section');
  });

  test('rejects LLM output missing frontmatter', async () => {
    const noFrontmatter = `# No Frontmatter

## Iron Law

Rule.

## When This Skill Activates

- stuff

## Methodology

1. step

## Anti-Patterns

| Thought | Reality |
|---------|---------|

## Quality Gate

- [ ] done
`;
    const gen = new SkillEngine(mockLLM(noFrontmatter), new PerformanceReader(testDir), testDir);
    await expect(gen.generate('agent-a', 'injection_vectors')).rejects.toThrow('missing frontmatter');
  });

  test('uses bundled template when no external templates exist', async () => {
    const llm = mockLLM(VALID_SKILL);
    const gen = new SkillEngine(llm, new PerformanceReader(testDir), testDir);
    await gen.generate('agent-a', 'injection_vectors');

    // First call is detectTechStack, second is skill generation
    const calls = (llm.generate as jest.Mock).mock.calls;
    const skillCall = calls.find((c: any) => c[0][0]?.content?.includes('<reference_skill>'));
    expect(skillCall).toBeDefined();
    const systemPrompt = skillCall![0][0].content;
    expect(systemPrompt).toContain('<reference_skill>');
    expect(systemPrompt).toContain('systematic-debugging');
  });

  test('assembles prompt with profiler data and project context', async () => {
    const llm = mockLLM(VALID_SKILL);
    const gen = new SkillEngine(llm, new PerformanceReader(testDir), testDir);
    await gen.generate('agent-a', 'injection_vectors');

    // Find the skill generation call (not the detectTechStack call)
    const calls = (llm.generate as jest.Mock).mock.calls;
    const skillCall = calls.find((c: any) => c[0].some((m: any) => m.content?.includes('Agent: agent-a')));
    expect(skillCall).toBeDefined();
    const userPrompt = skillCall![0][1].content;

    // Project context from bootstrap.md
    expect(userPrompt).toContain('Test Project');
    // Agent performance section
    expect(userPrompt).toContain('Agent: agent-a');
    expect(userPrompt).toContain('injection_vectors');
    // Category findings
    expect(userPrompt).toContain('Found unsanitized user input in prompt');
    // Peer scores (peer-b has 5 category_confirmed so score > 0.5)
    expect(userPrompt).toContain('peer-b');
    // Temperature option
    expect(skillCall![1]).toEqual({ temperature: 0.3 });
  });

  test('memoizes detectTechStack across multiple generate calls', async () => {
    const llm = mockLLM(VALID_SKILL);
    const gen = new SkillEngine(llm, new PerformanceReader(testDir), testDir);

    await gen.generate('agent-a', 'injection_vectors');
    await gen.generate('agent-a', 'concurrency');

    const calls = (llm.generate as jest.Mock).mock.calls;
    const techStackCalls = calls.filter((c: any) =>
      c[0][0]?.content?.includes("Analyze this project's tech stack")
    );
    // detectTechStack should only be called once despite two generate() calls
    expect(techStackCalls).toHaveLength(1);
  });
});
