import { TaskDispatcher, AgentRegistry, ILLMProvider, DispatchPlan } from '@gossip/orchestrator';
import { LLMMessage } from '@gossip/types';

// Mock LLM that returns canned decomposition based on task content
function createMockLLM(): ILLMProvider {
  return {
    async generate(messages: LLMMessage[]) {
      const rawContent = messages.find(m => m.role === 'user')?.content || '';
      const task = typeof rawContent === 'string' ? rawContent : '';
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

  it('returns warnings field in dispatch plan', async () => {
    const dispatcher = new TaskDispatcher(createMockLLM(), new AgentRegistry());
    const plan = await dispatcher.decompose('simple task');
    expect(plan.warnings).toBeDefined();
    expect(Array.isArray(plan.warnings)).toBe(true);
  });

  it('warns when required skill has no agent', async () => {
    const registry = new AgentRegistry();
    registry.register({ id: 'py', provider: 'local', model: 'qwen', skills: ['python'] });

    const dispatcher = new TaskDispatcher(createMockLLM(), registry);
    const plan = await dispatcher.decompose('simple task'); // needs 'typescript'
    dispatcher.assignAgents(plan);

    // typescript is required but no agent has it
    expect(plan.warnings!.some(w => w.includes('typescript'))).toBe(true);
  });
});

function mockLLM(response: string): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text: response }),
  };
}

function makeRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register({ id: 'gemini-implementer', provider: 'google', model: 'gemini-2.5-pro', skills: ['typescript', 'implementation'] });
  registry.register({ id: 'gemini-reviewer', provider: 'google', model: 'gemini-2.5-pro', skills: ['code_review', 'security_audit'] });
  return registry;
}

function makePlan(subTasks: Array<{ description: string; assignedAgent?: string }>): DispatchPlan {
  return {
    originalTask: 'test task',
    strategy: 'parallel',
    subTasks: subTasks.map((st, i) => ({
      id: `task-${i}`,
      description: st.description,
      requiredSkills: [],
      assignedAgent: st.assignedAgent,
      status: 'pending' as const,
    })),
  };
}

describe('TaskDispatcher.classifyWriteModes', () => {
  it('classifies write tasks with scoped mode', async () => {
    const llm = mockLLM(JSON.stringify([
      { index: 0, access: 'write', write_mode: 'scoped', scope: 'packages/tools/' },
      { index: 1, access: 'read' },
    ]));
    const dispatcher = new TaskDispatcher(llm as any, makeRegistry());
    const plan = makePlan([
      { description: 'Fix bug in packages/tools/', assignedAgent: 'gemini-implementer' },
      { description: 'Review the fix', assignedAgent: 'gemini-reviewer' },
    ]);

    const result = await dispatcher.classifyWriteModes(plan);

    expect(result).toHaveLength(2);
    expect(result[0].access).toBe('write');
    expect(result[0].writeMode).toBe('scoped');
    expect(result[0].scope).toBe('packages/tools/');
    expect(result[1].access).toBe('read');
    expect(result[1].writeMode).toBeUndefined();
  });

  it('falls back to all-read on invalid LLM response', async () => {
    const llm = mockLLM('This is not JSON at all');
    const dispatcher = new TaskDispatcher(llm as any, makeRegistry());
    const plan = makePlan([
      { description: 'Fix something', assignedAgent: 'gemini-implementer' },
    ]);

    const result = await dispatcher.classifyWriteModes(plan);

    expect(result).toHaveLength(1);
    expect(result[0].access).toBe('read');
  });

  it('falls back to all-read on LLM error', async () => {
    const llm = { generate: jest.fn().mockRejectedValue(new Error('API down')) };
    const dispatcher = new TaskDispatcher(llm as any, makeRegistry());
    const plan = makePlan([
      { description: 'Fix something', assignedAgent: 'gemini-implementer' },
    ]);

    const result = await dispatcher.classifyWriteModes(plan);

    expect(result).toHaveLength(1);
    expect(result[0].access).toBe('read');
  });

  it('handles unassigned sub-tasks', async () => {
    const llm = mockLLM(JSON.stringify([
      { index: 0, access: 'write', write_mode: 'sequential' },
    ]));
    const dispatcher = new TaskDispatcher(llm as any, makeRegistry());
    const plan = makePlan([
      { description: 'Do something' },
    ]);

    const result = await dispatcher.classifyWriteModes(plan);

    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('');
    expect(result[0].access).toBe('write');
    expect(result[0].writeMode).toBe('sequential');
  });
});
