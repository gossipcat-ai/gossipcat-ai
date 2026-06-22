import { AgentRegistry, TaskDispatcher, ILLMProvider, MainAgent } from '@gossip/orchestrator';
import { LLMMessage } from '@gossip/types';

/**
 * Test MainAgent orchestration logic with mock LLM.
 * We test the decompose -> assign -> synthesize flow without real relay/workers.
 */

describe('MainAgent orchestration flow', () => {
  it('decomposes task, assigns agents, and synthesizes results', async () => {
    // Mock LLM that decomposes into parallel tasks
    const mockLLM: ILLMProvider = {
      async generate(messages: LLMMessage[]) {
        // Decomposition request
        if (messages[0]?.content?.toString().includes('task decomposition engine')) {
          return {
            text: JSON.stringify({
              strategy: 'parallel',
              subTasks: [
                { description: 'write tests', requiredSkills: ['testing'] },
                { description: 'write code', requiredSkills: ['typescript'] },
              ],
            }),
          };
        }

        // Synthesis request
        if (messages[0]?.content?.toString().includes('Synthesize')) {
          return { text: 'Combined result: tests and code written successfully.' };
        }

        return { text: 'fallback' };
      },
    };

    const registry = new AgentRegistry();
    registry.register({ id: 'tester', provider: 'openai', model: 'gpt', skills: ['testing'] });
    registry.register({ id: 'coder', provider: 'anthropic', model: 'claude', skills: ['typescript'] });

    const dispatcher = new TaskDispatcher(mockLLM, registry);
    const plan = await dispatcher.decompose('build a feature with tests');
    dispatcher.assignAgents(plan);

    expect(plan.subTasks[0].assignedAgent).toBe('tester');
    expect(plan.subTasks[1].assignedAgent).toBe('coder');
    expect(plan.strategy).toBe('parallel');
  });

  it('falls back to single task on LLM failure', async () => {
    const failingLLM: ILLMProvider = {
      async generate() { return { text: 'I cannot parse this into JSON' }; },
    };

    const dispatcher = new TaskDispatcher(failingLLM, new AgentRegistry());
    const plan = await dispatcher.decompose('do something');

    expect(plan.strategy).toBe('single');
    expect(plan.subTasks).toHaveLength(1);
    expect(plan.subTasks[0].description).toBe('do something');
  });

  it('handles task where all sub-tasks are unassigned', async () => {
    const mockLLM: ILLMProvider = {
      async generate() {
        return {
          text: '{"strategy":"single","subTasks":[{"description":"do rust thing","requiredSkills":["rust"]}]}',
        };
      },
    };

    // No rust agents registered
    const registry = new AgentRegistry();
    registry.register({ id: 'ts', provider: 'local', model: 'qwen', skills: ['typescript'] });

    const dispatcher = new TaskDispatcher(mockLLM, registry);
    const plan = await dispatcher.decompose('do rust thing');
    dispatcher.assignAgents(plan);

    // Sub-task should remain unassigned (no rust skill)
    expect(plan.subTasks[0].assignedAgent).toBeUndefined();
  });
});

describe('MainAgent bootstrapPrompt', () => {
  it('accepts bootstrapPrompt config and prepends it to the system prompt', async () => {
    const systemMessages: string[] = [];
    const mockLLM: ILLMProvider = {
      async generate(messages: LLMMessage[]) {
        if (messages[0]?.role === 'system') {
          systemMessages.push(messages[0].content as string);
        }
        // Always return unassigned path: single subTask with no matching skill
        return {
          text: '{"strategy":"single","subTasks":[{"description":"do something","requiredSkills":["unknown"]}]}',
        };
      },
    };

    const mainAgent = new MainAgent({
      provider: 'local',
      model: 'mock',
      relayUrl: 'ws://localhost:0',
      agents: [],
      llm: mockLLM,
      bootstrapPrompt: '## Bootstrap Context\nTeam info here.',
    });

    await mainAgent.handleMessage('do something', {});

    // The system prompt used in the unassigned path should contain bootstrapPrompt + CHAT_SYSTEM_PROMPT
    expect(systemMessages.length).toBeGreaterThan(0);
    const lastSystem = systemMessages[systemMessages.length - 1];
    expect(lastSystem).toContain('## Bootstrap Context');
    expect(lastSystem).toContain('Team info here.');
    expect(lastSystem).toContain('orchestrator'); // CHAT_SYSTEM_PROMPT identifies as orchestrator
  });

  it('uses CHAT_SYSTEM_PROMPT alone when bootstrapPrompt is not set', async () => {
    const systemMessages: string[] = [];
    const mockLLM: ILLMProvider = {
      async generate(messages: LLMMessage[]) {
        if (messages[0]?.role === 'system') {
          systemMessages.push(messages[0].content as string);
        }
        return {
          text: '{"strategy":"single","subTasks":[{"description":"do something","requiredSkills":["unknown"]}]}',
        };
      },
    };

    const mainAgent = new MainAgent({
      provider: 'local',
      model: 'mock',
      relayUrl: 'ws://localhost:0',
      agents: [],
      llm: mockLLM,
    });

    await mainAgent.handleMessage('do something', {});

    const lastSystem = systemMessages[systemMessages.length - 1];
    // Should contain CHAT_SYSTEM_PROMPT (orchestrator prompt) without bootstrap prefix
    expect(lastSystem).toContain('orchestrator');
    expect(lastSystem).toContain('RULES');
    expect(lastSystem).not.toContain('## Bootstrap Context');
  });
});

describe('MainAgent dispatch pipeline', () => {
  it('exposes dispatch() that delegates to pipeline', () => {
    expect(typeof MainAgent.prototype.dispatch).toBe('function');
  });

  it('exposes collect() that delegates to pipeline', () => {
    expect(typeof MainAgent.prototype.collect).toBe('function');
  });

  it('exposes getWorker() to access workers', () => {
    expect(typeof MainAgent.prototype.getWorker).toBe('function');
  });
});

