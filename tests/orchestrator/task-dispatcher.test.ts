import { TaskDispatcher, AgentRegistry, ILLMProvider } from '@gossip/orchestrator';
import { LLMMessage } from '@gossip/types';

// Mock LLM that returns canned decomposition based on task content
function createMockLLM(): ILLMProvider {
  return {
    async generate(messages: LLMMessage[]) {
      const task = messages.find(m => m.role === 'user')?.content || '';
      if (task.includes('simple')) {
        return {
          text: '{"strategy":"single","subTasks":[{"description":"do the thing","requiredSkills":["typescript"]}]}',
        };
      }
      return {
        text: '{"strategy":"parallel","subTasks":[{"description":"implement auth","requiredSkills":["typescript","implementation"]},{"description":"review auth","requiredSkills":["code_review"]}]}',
      };
    },
  };
}

describe('TaskDispatcher', () => {
  it('decomposes a simple task into single sub-task', async () => {
    const registry = new AgentRegistry();
    const dispatcher = new TaskDispatcher(createMockLLM(), registry);
    const plan = await dispatcher.decompose('simple task');

    expect(plan.strategy).toBe('single');
    expect(plan.subTasks).toHaveLength(1);
    expect(plan.subTasks[0].description).toBe('do the thing');
    expect(plan.subTasks[0].status).toBe('pending');
    expect(plan.subTasks[0].id).toBeDefined();
    expect(plan.originalTask).toBe('simple task');
  });

  it('decomposes a complex task into parallel sub-tasks', async () => {
    const registry = new AgentRegistry();
    const dispatcher = new TaskDispatcher(createMockLLM(), registry);
    const plan = await dispatcher.decompose('implement and review auth');

    expect(plan.strategy).toBe('parallel');
    expect(plan.subTasks).toHaveLength(2);
    expect(plan.subTasks[0].description).toBe('implement auth');
    expect(plan.subTasks[1].description).toBe('review auth');
  });

  it('assigns agents by skill match', async () => {
    const registry = new AgentRegistry();
    registry.register({ id: 'impl', provider: 'openai', model: 'gpt', skills: ['typescript', 'implementation'] });
    registry.register({ id: 'rev', provider: 'anthropic', model: 'claude', skills: ['code_review'] });

    const dispatcher = new TaskDispatcher(createMockLLM(), registry);
    const plan = await dispatcher.decompose('implement and review auth');
    dispatcher.assignAgents(plan);

    expect(plan.subTasks[0].assignedAgent).toBe('impl');
    expect(plan.subTasks[1].assignedAgent).toBe('rev');
  });

  it('handles LLM returning invalid JSON gracefully', async () => {
    const badLLM: ILLMProvider = {
      async generate() { return { text: 'not json at all' }; },
    };
    const dispatcher = new TaskDispatcher(badLLM, new AgentRegistry());
    const plan = await dispatcher.decompose('some task');

    expect(plan.strategy).toBe('single');
    expect(plan.subTasks).toHaveLength(1);
    expect(plan.subTasks[0].description).toBe('some task');
  });

  it('handles LLM returning empty object gracefully', async () => {
    const emptyLLM: ILLMProvider = {
      async generate() { return { text: '{}' }; },
    };
    const dispatcher = new TaskDispatcher(emptyLLM, new AgentRegistry());
    const plan = await dispatcher.decompose('some task');

    expect(plan.strategy).toBe('single');
    expect(plan.subTasks).toHaveLength(0);
  });

  it('leaves sub-tasks unassigned when no agent matches', async () => {
    const registry = new AgentRegistry();
    registry.register({ id: 'py', provider: 'local', model: 'qwen', skills: ['python'] });

    const dispatcher = new TaskDispatcher(createMockLLM(), registry);
    const plan = await dispatcher.decompose('simple task');
    dispatcher.assignAgents(plan);

    // The sub-task needs 'typescript' but only 'python' agent exists
    expect(plan.subTasks[0].assignedAgent).toBeUndefined();
  });

  it('generates unique IDs for each sub-task', async () => {
    const dispatcher = new TaskDispatcher(createMockLLM(), new AgentRegistry());
    const plan = await dispatcher.decompose('implement and review auth');

    expect(plan.subTasks[0].id).not.toBe(plan.subTasks[1].id);
  });
});
