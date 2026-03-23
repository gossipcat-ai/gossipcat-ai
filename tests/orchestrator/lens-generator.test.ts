import { LensGenerator } from '../../packages/orchestrator/src/lens-generator';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import type { LLMResponse } from '../../packages/orchestrator/src/types';

function mockLLM(response: string): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text: response, toolCalls: [] } as LLMResponse),
  } as any;
}

describe('LensGenerator', () => {
  const agents = [
    { id: 'rev', preset: 'reviewer', skills: ['code_review', 'security_audit'] },
    { id: 'tst', preset: 'tester', skills: ['code_review', 'testing'] },
  ];
  const task = 'Review the authentication module';
  const sharedSkills = ['code_review'];

  it('generates valid lenses on happy path', async () => {
    const llm = mockLLM(JSON.stringify([
      { agentId: 'rev', focus: 'Focus on vulnerability identification', avoidOverlap: 'Do not check test coverage' },
      { agentId: 'tst', focus: 'Focus on testing gaps', avoidOverlap: 'Do not check for vulnerabilities' },
    ]));
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(2);
    expect(lenses[0].agentId).toBe('rev');
    expect(lenses[1].agentId).toBe('tst');
  });

  it('returns empty array on LLM failure', async () => {
    const llm = { generate: jest.fn().mockRejectedValue(new Error('Network error')) } as any;
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(0);
  });

  it('returns empty array on malformed JSON', async () => {
    const llm = mockLLM('not valid json {{{');
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(0);
  });

  it('includes agent presets and shared skills in the prompt', async () => {
    const llm = mockLLM('[]');
    const gen = new LensGenerator(llm);
    await gen.generateLenses(agents, task, sharedSkills);
    const prompt = (llm.generate as jest.Mock).mock.calls[0][0];
    const systemMsg = prompt.find((m: any) => m.role === 'system')?.content || '';
    expect(systemMsg).toContain('reviewer');
    expect(systemMsg).toContain('tester');
    expect(systemMsg).toContain('code_review');
  });

  it('detects semantically similar lenses and returns empty', async () => {
    const llm = mockLLM(JSON.stringify([
      { agentId: 'rev', focus: 'Focus on code quality and correctness', avoidOverlap: '' },
      { agentId: 'tst', focus: 'Focus on code correctness and quality', avoidOverlap: '' },
    ]));
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(0); // rejected — too similar
  });

  // Additional edge cases from tester review:
  it('returns empty when fewer than 2 agents', async () => {
    const llm = mockLLM('[]');
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses([agents[0]], task, sharedSkills);
    expect(lenses).toHaveLength(0);
    expect(llm.generate).not.toHaveBeenCalled(); // shouldn't even call LLM
  });

  it('returns empty when no shared skills', async () => {
    const llm = mockLLM('[]');
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, []);
    expect(lenses).toHaveLength(0);
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it('returns empty when LLM returns wrong number of lenses', async () => {
    const llm = mockLLM(JSON.stringify([
      { agentId: 'rev', focus: 'Focus on security', avoidOverlap: '' },
    ])); // only 1 lens for 2 agents
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(0);
  });

  it('handles markdown code block in LLM response', async () => {
    const json = JSON.stringify([
      { agentId: 'rev', focus: 'Focus on security', avoidOverlap: 'Skip testing' },
      { agentId: 'tst', focus: 'Focus on test coverage', avoidOverlap: 'Skip security' },
    ]);
    const llm = mockLLM('```json\n' + json + '\n```');
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(2);
  });
});
