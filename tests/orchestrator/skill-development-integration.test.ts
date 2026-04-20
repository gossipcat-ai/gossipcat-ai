import { SkillEngine, PerformanceReader, PerformanceWriter } from '@gossip/orchestrator';
import { loadSkills } from '../../packages/orchestrator/src/skill-loader';
import { ILLMProvider } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// L2: sanctioned internal accessor for tests (Step 5 exemption).
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

const VALID_SKILL = `---
name: injection-audit
category: injection_vectors
agent: test-agent
generated: 2026-03-28T00:00:00Z
effectiveness: 0.0
baseline_rate: 0.1
baseline_dispatches: 12
post_skill_dispatches: 0
version: 1
mode: contextual
keywords: [injection, xss, sql, sanitize]
---

# Injection Audit

## Iron Law

NO input assessment without tracing from entry to prompt.

## When This Skill Activates

- Injection, sanitization, prompt construction tasks

## Methodology

1. Map entry points
2. Trace input paths
3. Check sanitization
4. Test with adversarial input
5. Verify defense in depth

## Key Patterns

- Raw string interpolation in LLM prompts
- Missing data fence tags

## Anti-Patterns

| Thought | Reality |
|---------|---------|
| "Tags protect" | LLMs treat tags as advisory |

## Quality Gate

- [ ] Each finding cites file:line
- [ ] Evidence from actual code
`;

describe('Skill Development — Integration', () => {
  const testDir = join(tmpdir(), 'gossip-skilldev-integ-' + Date.now());
  let generator: SkillEngine;

  const mockLlm = {
    generate: jest.fn().mockResolvedValue({ text: VALID_SKILL, toolCalls: [] }),
  } as unknown as jest.Mocked<ILLMProvider>;

  beforeAll(() => {
    mkdirSync(join(testDir, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });
    const signals = [];
    for (let i = 0; i < 12; i++) {
      signals.push(JSON.stringify({ type: 'meta', signal: 'task_completed', agentId: 'test-agent', taskId: `t${i}`, value: 3000, timestamp: '2026-01-01T00:00:00Z' }));
    }
    signals.push(JSON.stringify({ type: 'consensus', signal: 'category_confirmed', agentId: 'test-agent', taskId: 't0', category: 'injection_vectors', evidence: 'Test finding', timestamp: '2026-01-01T00:00:00Z' }));
    writeFileSync(join(testDir, '.gossip', 'agent-performance.jsonl'), signals.join('\n') + '\n');
    writeFileSync(join(testDir, '.gossip', 'bootstrap.md'), '# Test Project');
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  beforeEach(() => {
    jest.clearAllMocks();
    (mockLlm.generate as jest.Mock).mockResolvedValue({ text: VALID_SKILL, toolCalls: [] });
    const profiler = new PerformanceReader(testDir);
    generator = new SkillEngine(mockLlm as any, profiler, testDir);
  });

  test('generate → file exists → loadSkills picks it up', async () => {
    const result = await generator.generate('test-agent', 'injection_vectors');

    // File was created
    expect(existsSync(result.path)).toBe(true);

    // loadSkills can find it when category is in skills array
    // normalizeSkillName converts injection_vectors → injection-vectors
    const skills = loadSkills('test-agent', ['injection-vectors'], testDir);
    expect(skills.content).toContain('Iron Law');
    expect(skills.content).toContain('Methodology');
  });

  test('generated skill file has correct frontmatter', async () => {
    const result = await generator.generate('test-agent', 'injection_vectors');
    expect(result.content).toContain('category: injection_vectors');
    expect(result.content).toContain('agent: test-agent');
    expect(result.content).toContain('effectiveness: 0.0');
  });

  test('prompt includes category findings from JSONL', async () => {
    await generator.generate('test-agent', 'injection_vectors');
    const callArgs = (mockLlm.generate as jest.Mock).mock.calls[1];
    const fullPrompt = callArgs[0].map((m: any) => m.content).join('\n');
    expect(fullPrompt).toContain('Test finding');
  });

  test('prompt includes peer score comparison', async () => {
    const writer = new PerformanceWriter(testDir);
    for (let i = 0; i < 12; i++) {
      writer[WRITER_INTERNAL].appendSignal({ type: 'meta', signal: 'task_completed', agentId: 'strong-peer', taskId: `sp${i}`, value: 2000, timestamp: new Date().toISOString() } as any);
    }
    for (let i = 0; i < 5; i++) {
      writer[WRITER_INTERNAL].appendSignal({ type: 'consensus', signal: 'category_confirmed', agentId: 'strong-peer', taskId: `sp${i}`, category: 'injection_vectors', evidence: 'Peer finding', timestamp: new Date().toISOString() } as any);
    }

    const freshProfiler = new PerformanceReader(testDir);
    const freshGenerator = new SkillEngine(mockLlm as any, freshProfiler, testDir);
    await freshGenerator.generate('test-agent', 'injection_vectors');

    const callArgs = (mockLlm.generate as jest.Mock).mock.calls[1];
    const fullPrompt = callArgs[0].map((m: any) => m.content).join('\n');
    expect(fullPrompt).toContain('strong-peer');
  });
});
