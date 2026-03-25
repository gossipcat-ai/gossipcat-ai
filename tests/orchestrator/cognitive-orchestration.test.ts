import { MainAgent, ILLMProvider, PLAN_CHOICES, PENDING_PLAN_CHOICES } from '@gossip/orchestrator';
import { LLMMessage } from '@gossip/types';

/**
 * Test cognitive orchestration mode in MainAgent:
 * - Plain chat (no tool call)
 * - Tool call detection and execution
 * - Decompose mode preservation
 * - Conversation history
 * - Plan approval via handleChoice
 * - Instruction update confirmation via handleChoice
 */

function createMockLLM(handler: (messages: LLMMessage[]) => string): ILLMProvider {
  return {
    async generate(messages: LLMMessage[]) {
      return { text: handler(messages) };
    },
  };
}

const DEFAULT_AGENTS = [
  { id: 'default-agent', provider: 'anthropic' as const, model: 'claude', skills: ['general'] },
];

function createMainAgent(
  llm: ILLMProvider,
  agents: Array<{ id: string; provider: string; model: string; skills: string[] }> = DEFAULT_AGENTS,
  opts?: { keyProvider?: (provider: string) => Promise<string | null> },
) {
  return new MainAgent({
    provider: 'local',
    model: 'mock',
    relayUrl: 'ws://localhost:0',
    agents: agents as any,
    llm,
    projectRoot: '/tmp/cognitive-test-' + Date.now(),
    bootstrapPrompt: '## Team\nTest team.',
    keyProvider: opts?.keyProvider,
  });
}

describe('Cognitive Orchestration', () => {
  it('should return plain chat when LLM responds without tool call', async () => {
    const llm = createMockLLM(() => 'Hello! I can help you with that.');
    const agent = createMainAgent(llm);

    const result = await agent.handleMessage('hi there');

    expect(result.text).toBe('Hello! I can help you with that.');
    expect(result.status).toBe('done');
    expect(result.agents).toBeUndefined();
    expect(result.choices).toBeUndefined();
  });

  it('should detect and execute tool call via agents tool', async () => {
    const agents = [
      { id: 'coder', provider: 'anthropic' as const, model: 'claude', skills: ['typescript'] },
      { id: 'reviewer', provider: 'openai' as const, model: 'gpt', skills: ['code_review'] },
    ];

    const llm = createMockLLM(() =>
      'Here are your agents:\n\n[TOOL_CALL]\n{"tool": "agents", "args": {}}\n[/TOOL_CALL]'
    );
    const agent = createMainAgent(llm, agents);

    const result = await agent.handleMessage('list my agents');

    expect(result.text).toContain('Registered Agents');
    expect(result.text).toContain('coder');
    expect(result.text).toContain('reviewer');
    expect(result.status).toBe('done');
  });

  it('should preserve decompose mode', async () => {
    const calls: string[] = [];
    const llm = createMockLLM((messages) => {
      const sys = messages[0]?.content?.toString() ?? '';
      if (sys.includes('task decomposition engine')) {
        calls.push('decompose');
        return JSON.stringify({
          strategy: 'single',
          subTasks: [{ description: 'do thing', requiredSkills: ['unknown'] }],
        });
      }
      calls.push('chat');
      return 'Chat response.';
    });
    const agent = createMainAgent(llm);

    const result = await agent.handleMessage('do thing', { mode: 'decompose' });

    // Decompose was called (task decomposition engine prompt) then fallback to chat
    expect(calls).toContain('decompose');
    expect(result.status).toBe('done');
  });

  it('should maintain conversation history', async () => {
    let callCount = 0;
    const receivedMessages: LLMMessage[][] = [];

    const llm = createMockLLM((messages) => {
      receivedMessages.push([...messages]);
      callCount++;
      return `Response ${callCount}`;
    });
    const agent = createMainAgent(llm);

    await agent.handleMessage('first message');
    await agent.handleMessage('second message');

    // Second call should have history from first call
    const secondCallMessages = receivedMessages[1];
    // Should have: system, user (history), assistant (history), user (current)
    expect(secondCallMessages.length).toBeGreaterThanOrEqual(4);

    // Find the history user message
    const userMessages = secondCallMessages.filter(m => m.role === 'user');
    expect(userMessages.some(m => m.content === 'first message')).toBe(true);
    expect(userMessages.some(m => m.content === 'second message')).toBe(true);

    // Find the history assistant message
    const assistantMessages = secondCallMessages.filter(m => m.role === 'assistant');
    expect(assistantMessages.some(m => (m.content as string).includes('Response 1'))).toBe(true);
  });

  it('should trim conversation history to MAX_HISTORY', async () => {
    const receivedMessages: LLMMessage[][] = [];

    const llm = createMockLLM((messages) => {
      receivedMessages.push([...messages]);
      return 'ok';
    });
    const agent = createMainAgent(llm);

    // Send 12 messages (24 history entries = 12 user + 12 assistant, over the 20 limit)
    for (let i = 0; i < 12; i++) {
      await agent.handleMessage(`message ${i}`);
    }

    // The last call should have system + 20 history entries + 1 current user = 22
    const lastCall = receivedMessages[receivedMessages.length - 1];
    const nonSystem = lastCall.filter(m => m.role !== 'system');
    // 20 history + 1 current user = 21 max
    expect(nonSystem.length).toBeLessThanOrEqual(21);
  });

  it('should handle plan approval via handleChoice with EXECUTE', async () => {
    // Create agent with registered agents so dispatch can work
    const agents = [
      { id: 'coder', provider: 'anthropic' as const, model: 'claude', skills: ['typescript'] },
    ];

    const llm = createMockLLM(() => 'done');
    const mainAgent = createMainAgent(llm, agents);

    // Manually set pending plan on toolExecutor (access via type assertion)
    const executor = (mainAgent as any).toolExecutor;
    executor.pendingPlan = {
      plan: { originalTask: 'test', subTasks: [], strategy: 'single' as const },
      tasks: [],
    };

    // Mock executePlan
    executor.executePlan = jest.fn().mockResolvedValue({
      text: 'Plan executed successfully.',
      agents: ['coder'],
    });

    const result = await mainAgent.handleChoice('test task', PLAN_CHOICES.EXECUTE);

    expect(result.text).toBe('Plan executed successfully.');
    expect(result.status).toBe('done');
    expect(result.agents).toEqual(['coder']);
    expect(executor.pendingPlan).toBeNull();
    expect(executor.executePlan).toHaveBeenCalledTimes(1);
  });

  it('should handle plan cancellation via handleChoice', async () => {
    const llm = createMockLLM(() => 'ok');
    const mainAgent = createMainAgent(llm);

    const executor = (mainAgent as any).toolExecutor;
    executor.pendingPlan = {
      plan: { originalTask: 'test', subTasks: [], strategy: 'single' as const },
      tasks: [],
    };

    const result = await mainAgent.handleChoice('test task', PLAN_CHOICES.CANCEL);

    expect(result.text).toBe('Plan cancelled.');
    expect(result.status).toBe('done');
    expect(executor.pendingPlan).toBeNull();
  });

  it('should handle pending plan discard via handleChoice', async () => {
    const llm = createMockLLM(() => 'ok');
    const mainAgent = createMainAgent(llm);

    const executor = (mainAgent as any).toolExecutor;
    executor.pendingPlan = {
      plan: { originalTask: 'test', subTasks: [], strategy: 'single' as const },
      tasks: [],
    };

    const result = await mainAgent.handleChoice('test task', PENDING_PLAN_CHOICES.DISCARD);

    expect(result.text).toBe('Old plan discarded. Send your new task.');
    expect(result.status).toBe('done');
    expect(executor.pendingPlan).toBeNull();
  });

  it('should handle execute_pending via handleChoice', async () => {
    const llm = createMockLLM(() => 'ok');
    const mainAgent = createMainAgent(llm);

    const executor = (mainAgent as any).toolExecutor;
    const pendingPlan = {
      plan: { originalTask: 'test', subTasks: [], strategy: 'single' as const },
      tasks: [],
    };
    executor.pendingPlan = pendingPlan;
    executor.executePlan = jest.fn().mockResolvedValue({
      text: 'Pending plan executed.',
      agents: ['coder'],
    });

    const result = await mainAgent.handleChoice('test', PENDING_PLAN_CHOICES.EXECUTE_PENDING);

    expect(result.text).toBe('Pending plan executed.');
    expect(executor.pendingPlan).toBeNull();
    expect(executor.executePlan).toHaveBeenCalledWith(pendingPlan);
  });

  it('should handle instruction update confirmation via handleChoice', async () => {
    const llm = createMockLLM(() => 'ok');
    const mainAgent = createMainAgent(llm);

    const executor = (mainAgent as any).toolExecutor;
    const pending = { agentIds: ['coder'], instruction: 'Be more concise.' };
    executor.pendingInstructionUpdate = pending;
    executor.applyInstructionUpdate = jest.fn().mockResolvedValue({
      text: 'Updated instructions for: coder',
    });

    const result = await mainAgent.handleChoice('update instructions', 'apply');

    expect(result.text).toBe('Updated instructions for: coder');
    expect(result.status).toBe('done');
    expect(executor.pendingInstructionUpdate).toBeNull();
    expect(executor.applyInstructionUpdate).toHaveBeenCalledWith(pending);
  });

  it('should handle instruction update cancellation via handleChoice', async () => {
    const llm = createMockLLM(() => 'ok');
    const mainAgent = createMainAgent(llm);

    const executor = (mainAgent as any).toolExecutor;
    executor.pendingInstructionUpdate = { agentIds: ['coder'], instruction: 'Be more concise.' };

    const result = await mainAgent.handleChoice('update instructions', 'cancel');

    expect(result.text).toBe('Instruction update cancelled.');
    expect(result.status).toBe('done');
    expect(executor.pendingInstructionUpdate).toBeNull();
  });

  it('should parse CHOICES in cognitive mode', async () => {
    const llm = createMockLLM(() =>
      'Here are your options:\n\n[CHOICES]\nmessage: Which approach?\n- fast | Fast approach | Quick but rough\n- careful | Careful approach | Slow but thorough\n[/CHOICES]'
    );
    const agent = createMainAgent(llm);

    const result = await agent.handleMessage('how should I do this?');

    expect(result.text).toBe('Here are your options:');
    expect(result.choices).toBeDefined();
    expect(result.choices!.message).toBe('Which approach?');
    expect(result.choices!.options).toHaveLength(2);
    expect(result.choices!.options[0].value).toBe('fast');
    expect(result.choices!.options[1].value).toBe('careful');
  });

  it('should include tool explanation text with tool result', async () => {
    const agents = [
      { id: 'coder', provider: 'anthropic' as const, model: 'claude', skills: ['typescript'] },
    ];

    const llm = createMockLLM(() =>
      'Let me check the team for you.\n\n[TOOL_CALL]\n{"tool": "agents", "args": {}}\n[/TOOL_CALL]'
    );
    const agent = createMainAgent(llm, agents);

    const result = await agent.handleMessage('who is on the team?');

    expect(result.text).toContain('Let me check the team for you.');
    expect(result.text).toContain('Registered Agents');
    expect(result.text).toContain('coder');
  });

  it('should prioritize TOOL_CALL over CHOICES when both are present', async () => {
    const agents = [
      { id: 'coder', provider: 'anthropic' as const, model: 'claude', skills: ['typescript'] },
    ];

    const llm = createMockLLM(() =>
      'Let me check.\n\n[TOOL_CALL]\n{"tool": "agents", "args": {}}\n[/TOOL_CALL]\n\n[CHOICES]\nmessage: Pick one?\n- a | Option A\n- b | Option B\n[/CHOICES]'
    );
    const agent = createMainAgent(llm, agents);

    const result = await agent.handleMessage('what should I do?');

    // Tool call should be executed (agents listing)
    expect(result.text).toContain('Registered Agents');
    expect(result.text).toContain('coder');
    // CHOICES should NOT be parsed since TOOL_CALL takes precedence
    expect(result.choices).toBeUndefined();
  });

  it('should fall back to normal handleChoice when no pending state', async () => {
    const llm = createMockLLM(() => 'Proceeding with fast approach.');
    const mainAgent = createMainAgent(llm);

    const result = await mainAgent.handleChoice('how to do this?', 'fast');

    expect(result.text).toBe('Proceeding with fast approach.');
    expect(result.status).toBe('done');
  });

  it('should brainstorm first when no agents configured', async () => {
    // With brainstorm-before-team flow, the first message goes to cognitive mode
    // for brainstorming (no tool call, no team proposal yet)
    const llm = createMockLLM(() => 'Great idea! Here are some approaches for a REST API...');
    const mainAgent = createMainAgent(llm, []);

    const result = await mainAgent.handleMessage('build a REST API');

    // Should brainstorm, not immediately propose a team
    expect(result.text).toContain('REST API');
    expect(result.status).toBe('done');
    // No choices on first message — brainstorming is pure text
  });

  it('should handle skip choice during init flow', async () => {
    const llm = createMockLLM(() => 'ok');
    const mainAgent = createMainAgent(llm, []);

    // Manually set pending task to simulate init flow state
    const initializer = (mainAgent as any).projectInitializer;
    initializer.pendingTask = 'build something';
    initializer.pendingProposal = { agents: [] };

    const result = await mainAgent.handleChoice('build something', 'skip');

    expect(result.text).toContain('No agents configured');
    expect(result.status).toBe('done');
    expect(initializer.pendingTask).toBeNull();
    expect(initializer.pendingProposal).toBeNull();
  });

  it('should handle team add approval', async () => {
    const agents = [
      { id: 'existing', provider: 'anthropic' as const, model: 'claude', skills: ['typescript'] },
    ];
    const llm = createMockLLM(() => 'ok');
    const mainAgent = createMainAgent(llm, agents);

    // Set up pending team add action
    const tm = (mainAgent as any).teamManager;
    tm.pendingAction = {
      action: 'add',
      agentId: 'new-reviewer',
      config: { id: 'new-reviewer', provider: 'google', model: 'gemini', preset: 'reviewer', skills: ['code_review'] },
    };

    // Mock registry.register and writeConfig to avoid filesystem
    const registered: any[] = [];
    const registry = (mainAgent as any).registry;
    const origRegister = registry.register.bind(registry);
    registry.register = (c: any) => { registered.push(c); origRegister(c); };
    tm.writeConfig = () => {};

    const result = await mainAgent.handleChoice('add reviewer', 'confirm_add');

    expect(result.text).toContain('Added new-reviewer');
    expect(result.status).toBe('done');
    expect(registered.some((r: any) => r.id === 'new-reviewer')).toBe(true);
  });

  it('should handle team cancel', async () => {
    const agents = [
      { id: 'existing', provider: 'anthropic' as const, model: 'claude', skills: ['typescript'] },
    ];
    const llm = createMockLLM(() => 'ok');
    const mainAgent = createMainAgent(llm, agents);

    const tm = (mainAgent as any).teamManager;
    tm.pendingAction = { action: 'add', agentId: 'new-agent', config: {} };

    const result = await mainAgent.handleChoice('add agent', 'cancel');

    expect(result.text).toBe('Cancelled.');
    expect(result.status).toBe('done');
    expect(tm.pendingAction).toBeNull();
  });
});
