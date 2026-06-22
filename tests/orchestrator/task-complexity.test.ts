import { MainAgent, AgentRegistry, ILLMProvider } from '@gossip/orchestrator';

describe('classifyTaskComplexity', () => {
  let mockLLM: ILLMProvider;
  let registry: AgentRegistry;

  beforeEach(() => {
    mockLLM = {
      generate: jest.fn(),
    };

    registry = new AgentRegistry();
    registry.register({
      id: 'sonnet-impl',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      preset: 'implementer',
      skills: ['typescript', 'react'],
    });
    registry.register({
      id: 'sonnet-reviewer',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      preset: 'reviewer',
      skills: ['code_review', 'security_audit'],
    });
  });

  function makeAgent(): MainAgent {
    const agent = new MainAgent({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      relayUrl: 'ws://localhost:9000',
      agents: [],
      llm: mockLLM,
    });
    // Register agents so classifyTaskComplexity can see them
    agent.registerAgent({
      id: 'sonnet-impl',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      preset: 'implementer',
      skills: ['typescript', 'react'],
    });
    agent.registerAgent({
      id: 'sonnet-reviewer',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      preset: 'reviewer',
      skills: ['code_review', 'security_audit'],
    });
    return agent;
  }

  it('returns single with agent ID when LLM picks an agent', async () => {
    (mockLLM.generate as jest.Mock).mockResolvedValue({ text: 'single:sonnet-impl' });

    const agent = makeAgent();
    const result = await agent.classifyTaskComplexity('Fix the typo in the README');

    expect(result).toEqual({ complexity: 'single', agentId: 'sonnet-impl' });
  });

  it('returns single with reviewer when LLM picks reviewer for review task', async () => {
    (mockLLM.generate as jest.Mock).mockResolvedValue({ text: 'single:sonnet-reviewer' });

    const agent = makeAgent();
    const result = await agent.classifyTaskComplexity('Review the auth module for security issues');

    expect(result).toEqual({ complexity: 'single', agentId: 'sonnet-reviewer' });
  });

  it('returns multi for complex tasks', async () => {
    (mockLLM.generate as jest.Mock).mockResolvedValue({ text: 'multi' });

    const agent = makeAgent();
    const result = await agent.classifyTaskComplexity(
      'Add auth system, refactor the database layer, and write E2E tests'
    );

    expect(result).toEqual({ complexity: 'multi' });
  });

  it('returns single without agentId when LLM returns bare "single"', async () => {
    (mockLLM.generate as jest.Mock).mockResolvedValue({ text: 'single' });

    const agent = makeAgent();
    const result = await agent.classifyTaskComplexity('Do something');

    expect(result).toEqual({ complexity: 'single' });
  });

  it('defaults to single when LLM returns verbose unparseable text', async () => {
    (mockLLM.generate as jest.Mock).mockResolvedValue({
      text: 'I think this task is quite complex and involves multiple concerns.',
    });

    const agent = makeAgent();
    const result = await agent.classifyTaskComplexity('Do something');

    expect(result).toEqual({ complexity: 'single' });
  });

  it('returns single without agentId when LLM picks non-existent agent', async () => {
    (mockLLM.generate as jest.Mock).mockResolvedValue({ text: 'single:nonexistent-agent' });

    const agent = makeAgent();
    const result = await agent.classifyTaskComplexity('Fix something');

    // Agent doesn't exist in registry — falls back to no agentId
    expect(result).toEqual({ complexity: 'single' });
  });
});
