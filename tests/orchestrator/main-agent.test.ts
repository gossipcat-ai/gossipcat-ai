import { AgentRegistry, TaskDispatcher, ILLMProvider } from '@gossip/orchestrator';
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
