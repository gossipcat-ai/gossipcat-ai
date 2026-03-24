import { ToolRouter, ToolExecutor } from '../../packages/orchestrator/src/tool-router';

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readFileSync: jest.fn(actual.readFileSync),
  };
});

import { existsSync, readFileSync } from 'fs';
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;

describe('ToolRouter', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => stderrSpy.mockRestore());

  describe('parseToolCall', () => {
    it('parses valid tool call with text before it', () => {
      const text = `I'll dispatch this task now.

[TOOL_CALL]
{"tool": "dispatch", "args": {"agent_id": "reviewer", "task": "review code"}}
[/TOOL_CALL]`;
      const result = ToolRouter.parseToolCall(text);
      expect(result).toEqual({
        tool: 'dispatch',
        args: { agent_id: 'reviewer', task: 'review code' },
      });
    });

    it('returns null for plain text (no tool call)', () => {
      expect(ToolRouter.parseToolCall('Just a normal response.')).toBeNull();
    });

    it('returns null for unknown tool name', () => {
      const text = '[TOOL_CALL]\n{"tool": "hack_system", "args": {}}\n[/TOOL_CALL]';
      expect(ToolRouter.parseToolCall(text)).toBeNull();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unknown tool'));
    });

    it('handles markdown code fences inside block', () => {
      const text = `[TOOL_CALL]
\`\`\`json
{"tool": "agents", "args": {}}
\`\`\`
[/TOOL_CALL]`;
      expect(ToolRouter.parseToolCall(text)).toEqual({ tool: 'agents', args: {} });
    });

    it('handles YAML-like format in code fences (real LLM output)', () => {
      const text = "Here are your agents.\n```\n[TOOL_CALL]\ntool: agents\nargs: {}\n```";
      expect(ToolRouter.parseToolCall(text)).toEqual({ tool: 'agents', args: {} });
    });

    it('handles YAML-like format with string args', () => {
      const text = '```\n[TOOL_CALL]\ntool: dispatch\nargs:\n  agent_id: gemini-reviewer\n  task: "review this code"\n```';
      const result = ToolRouter.parseToolCall(text);
      expect(result).not.toBeNull();
      expect(result!.tool).toBe('dispatch');
      expect(result!.args.agent_id).toBe('gemini-reviewer');
      expect(result!.args.task).toContain('review this code');
    });

    it('handles [TOOL_CALL] at end of text without closing tag', () => {
      const text = 'I\'ll plan this.\n\n[TOOL_CALL]\ntool: plan\nargs:\n    task: "build a snake game"';
      const result = ToolRouter.parseToolCall(text);
      expect(result).not.toBeNull();
      expect(result!.tool).toBe('plan');
      expect(result!.args.task).toContain('snake game');
    });

    it('normalizes MCP-style tool names (gossip_plan → plan)', () => {
      const text = '[TOOL_CALL]\ntool: gossip_plan\nargs:\n  task: "test"';
      const result = ToolRouter.parseToolCall(text);
      expect(result).not.toBeNull();
      expect(result!.tool).toBe('plan');
    });

    it('handles trailing commas in JSON', () => {
      const text = `[TOOL_CALL]
{"tool": "dispatch", "args": {"agent_id": "writer", "task": "write tests",}}
[/TOOL_CALL]`;
      const result = ToolRouter.parseToolCall(text);
      expect(result).toEqual({
        tool: 'dispatch',
        args: { agent_id: 'writer', task: 'write tests' },
      });
    });

    it('extracts only first tool call if multiple exist', () => {
      const text = `[TOOL_CALL]
{"tool": "agents", "args": {}}
[/TOOL_CALL]
[TOOL_CALL]
{"tool": "plan", "args": {"task": "ignored"}}
[/TOOL_CALL]`;
      expect(ToolRouter.parseToolCall(text)).toEqual({ tool: 'agents', args: {} });
    });

    it('returns null for malformed JSON', () => {
      const text = '[TOOL_CALL]\n{not valid json}\n[/TOOL_CALL]';
      expect(ToolRouter.parseToolCall(text)).toBeNull();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('failed to parse'));
    });

    it('returns null for missing required args', () => {
      const text = '[TOOL_CALL]\n{"tool": "dispatch", "args": {"agent_id": "x"}}\n[/TOOL_CALL]';
      expect(ToolRouter.parseToolCall(text)).toBeNull();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("missing required arg 'task'"));
    });

    it('rejects agent_id with path traversal', () => {
      const text = '[TOOL_CALL]\n{"tool": "agent_status", "args": {"agent_id": "../etc/passwd"}}\n[/TOOL_CALL]';
      expect(ToolRouter.parseToolCall(text)).toBeNull();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('invalid agent_id'));
    });

    it('rejects invalid entries in agent_ids array', () => {
      const text = `[TOOL_CALL]
{"tool": "update_instructions", "args": {"agent_ids": ["ok", "bad/../id"], "instruction": "test"}}
[/TOOL_CALL]`;
      expect(ToolRouter.parseToolCall(text)).toBeNull();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('invalid agent_id in agent_ids'));
    });
  });

  describe('stripToolCallBlocks', () => {
    it('removes all tool call blocks', () => {
      const text = `Here is my analysis.

[TOOL_CALL]
{"tool": "agents", "args": {}}
[/TOOL_CALL]

Done.`;
      expect(ToolRouter.stripToolCallBlocks(text)).toBe('Here is my analysis.\n\nDone.');
    });

    it('handles text with no blocks', () => {
      expect(ToolRouter.stripToolCallBlocks('plain text')).toBe('plain text');
    });

    it('warns on multiple blocks', () => {
      const text = `A
[TOOL_CALL]{"tool":"a","args":{}}[/TOOL_CALL]
B
[TOOL_CALL]{"tool":"b","args":{}}[/TOOL_CALL]
C`;
      ToolRouter.stripToolCallBlocks(text);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('2 tool call blocks found'));
    });
  });
});

describe('ToolExecutor', () => {
  let stderrSpy: jest.SpyInstance;
  let executor: ToolExecutor;
  let mockPipeline: any;
  let mockRegistry: any;

  const agent1 = { id: 'reviewer', provider: 'anthropic', model: 'sonnet', skills: ['code-review', 'testing'] };
  const agent2 = { id: 'writer', provider: 'anthropic', model: 'sonnet', skills: ['typescript', 'writing'] };

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);

    mockPipeline = {
      dispatch: jest.fn().mockReturnValue({
        taskId: 'task-1',
        promise: Promise.resolve('done'),
      }),
      dispatchParallel: jest.fn().mockResolvedValue({
        taskIds: ['task-1', 'task-2'],
        errors: [],
      }),
      collect: jest.fn().mockResolvedValue({
        results: [
          { id: 'task-1', agentId: 'reviewer', task: 'review', status: 'completed', result: 'Looks good', startedAt: Date.now() },
          { id: 'task-2', agentId: 'writer', task: 'write', status: 'completed', result: 'Written', startedAt: Date.now() },
        ],
      }),
    };

    mockRegistry = {
      get: jest.fn((id: string) => {
        if (id === 'reviewer') return agent1;
        if (id === 'writer') return agent2;
        return undefined;
      }),
      getAll: jest.fn().mockReturnValue([agent1, agent2]),
    };

    executor = new ToolExecutor({
      pipeline: mockPipeline,
      registry: mockRegistry,
      projectRoot: '/tmp/test-project',
    });
  });

  afterEach(() => stderrSpy.mockRestore());

  it('dispatch with auto-chain collect', async () => {
    const result = await executor.execute({ tool: 'dispatch', args: { agent_id: 'reviewer', task: 'review code' } });

    expect(mockPipeline.dispatch).toHaveBeenCalledWith('reviewer', 'review code');
    expect(mockPipeline.collect).toHaveBeenCalledWith(['task-1'], 120_000);
    expect(result.text).toBe('Looks good');
    expect(result.agents).toEqual(['reviewer']);
  });

  it('agents tool returns list', async () => {
    const result = await executor.execute({ tool: 'agents', args: {} });

    expect(result.text).toContain('reviewer');
    expect(result.text).toContain('writer');
    expect(result.text).toContain('code-review');
    expect(result.text).toContain('Registered Agents');
  });

  it('dispatch to unknown agent returns error', async () => {
    const result = await executor.execute({ tool: 'dispatch', args: { agent_id: 'ghost', task: 'haunt code' } });

    expect(result.text).toContain('agent "ghost" not found');
    expect(mockPipeline.dispatch).not.toHaveBeenCalled();
  });

  it('dispatch_consensus with all agents', async () => {
    mockPipeline.collect.mockResolvedValueOnce({
      results: [
        { id: 'task-1', agentId: 'reviewer', task: 'review', status: 'completed', result: 'Review done', startedAt: Date.now() },
        { id: 'task-2', agentId: 'writer', task: 'review', status: 'completed', result: 'Also done', startedAt: Date.now() },
      ],
      consensus: { summary: 'Both agents agree.', agentCount: 2, rounds: 2, confirmed: [], disputed: [], unique: [], newFindings: [], signals: [] },
    });

    const result = await executor.execute({ tool: 'dispatch_consensus', args: { task: 'review everything' } });

    expect(mockPipeline.dispatchParallel).toHaveBeenCalledWith(
      expect.arrayContaining([
        { agentId: 'reviewer', task: 'review everything' },
        { agentId: 'writer', task: 'review everything' },
      ]),
      { consensus: true },
    );
    expect(mockPipeline.collect).toHaveBeenCalledWith(['task-1', 'task-2'], 300_000, { consensus: true });
    expect(result.text).toContain('Review done');
    expect(result.text).toContain('Consensus Report');
    expect(result.text).toContain('Both agents agree');
    expect(result.agents).toEqual(['reviewer', 'writer']);
  });

  it('pipeline error returns error text (not throw)', async () => {
    mockPipeline.dispatch.mockImplementation(() => { throw new Error('connection refused'); });

    const result = await executor.execute({ tool: 'dispatch', args: { agent_id: 'reviewer', task: 'do stuff' } });

    expect(result.text).toBe('Tool error: connection refused');
  });

  it('update_instructions stores pending and returns CHOICES', async () => {
    const result = await executor.execute({
      tool: 'update_instructions',
      args: { agent_ids: ['reviewer', 'writer'], instruction: 'Focus on security' },
    });

    expect(executor.pendingInstructionUpdate).toEqual({
      agentIds: ['reviewer', 'writer'],
      instruction: 'Focus on security',
    });
    expect(result.text).toContain('reviewer');
    expect(result.text).toContain('writer');
    expect(result.choices).toBeDefined();
    expect(result.choices!.options).toHaveLength(2);
    expect(result.choices!.options[0].value).toBe('apply');
  });

  it('dispatch_parallel validates all agents and auto-chains collect', async () => {
    const result = await executor.execute({
      tool: 'dispatch_parallel',
      args: { tasks: [{ agent_id: 'reviewer', task: 'review' }, { agent_id: 'writer', task: 'write' }] },
    });

    expect(mockPipeline.dispatchParallel).toHaveBeenCalled();
    expect(mockPipeline.collect).toHaveBeenCalledWith(['task-1', 'task-2'], 120_000);
    expect(result.text).toContain('[reviewer]');
    expect(result.text).toContain('[writer]');
    expect(result.agents).toEqual(['reviewer', 'writer']);
  });

  it('dispatch_parallel with unknown agent returns error without dispatching', async () => {
    const result = await executor.execute({
      tool: 'dispatch_parallel',
      args: { tasks: [{ agent_id: 'reviewer', task: 'review' }, { agent_id: 'ghost', task: 'haunt' }] },
    });

    expect(result.text).toContain('agent "ghost" not found');
    expect(mockPipeline.dispatchParallel).not.toHaveBeenCalled();
  });

  it('plan with pending plan returns PENDING_PLAN_CHOICES', async () => {
    executor.pendingPlan = {
      plan: { originalTask: 'old', subTasks: [], strategy: 'parallel' },
      tasks: [],
    };

    const result = await executor.execute({ tool: 'plan', args: { task: 'new plan' } });

    expect(result.text).toContain('already pending');
    expect(result.choices).toBeDefined();
    expect(result.choices!.options.some((o: any) => o.value === 'discard_and_replan')).toBe(true);
  });

  it('update_instructions rejects unknown agent', async () => {
    const result = await executor.execute({
      tool: 'update_instructions',
      args: { agent_ids: ['reviewer', 'ghost'], instruction: 'test' },
    });

    expect(result.text).toContain('agent "ghost" not found');
    expect(executor.pendingInstructionUpdate).toBeNull();
  });

  it('unknown tool returns error', async () => {
    const result = await executor.execute({ tool: 'nonexistent', args: {} });
    expect(result.text).toContain('unknown tool');
  });

  // ── agent_status ────────────────────────────────────────────────────

  it('agent_status returns recent tasks for valid agent', async () => {
    const jsonlData = [
      JSON.stringify({ task: 'review PR #1', warmth: 0.8, timestamp: '2026-03-24T01:00:00Z' }),
      JSON.stringify({ task: 'review PR #2', warmth: 0.9, timestamp: '2026-03-24T02:00:00Z' }),
      JSON.stringify({ task: 'review PR #3', warmth: 0.7, timestamp: '2026-03-24T03:00:00Z' }),
    ].join('\n');

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonlData);

    const result = await executor.execute({ tool: 'agent_status', args: { agent_id: 'reviewer' } });

    expect(result.text).toContain('Agent Status: reviewer');
    expect(result.text).toContain('review PR #1');
    expect(result.text).toContain('review PR #3');
    expect(result.text).toContain('warmth: 0.8');
    expect(result.text).toContain('Last 3 tasks');

    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
  });

  it('agent_status returns error for unknown agent', async () => {
    const result = await executor.execute({ tool: 'agent_status', args: { agent_id: 'ghost' } });

    expect(result.text).toContain('agent "ghost" not found');
  });

  // ── agent_performance ───────────────────────────────────────────────

  it('agent_performance returns signal summary', async () => {
    const jsonlData = [
      JSON.stringify({ agentId: 'reviewer', signal: 'agreement', outcome: 'confirmed' }),
      JSON.stringify({ agentId: 'reviewer', signal: 'disagreement', outcome: 'disputed' }),
      JSON.stringify({ agentId: 'writer', signal: 'agreement', outcome: 'confirmed' }),
    ].join('\n');

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonlData);

    const result = await executor.execute({ tool: 'agent_performance', args: {} });

    expect(result.text).toContain('Agent Performance');
    expect(result.text).toContain('### reviewer');
    expect(result.text).toContain('### writer');
    expect(result.text).toContain('agreement (confirmed)');
    expect(result.text).toContain('disagreement (disputed)');
    expect(result.text).toContain('last 3 signals');

    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
  });

  it('agent_performance returns message when no data', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await executor.execute({ tool: 'agent_performance', args: {} });

    expect(result.text).toBe('No performance data found.');

    mockExistsSync.mockReset();
  });

  // ── read_task_history ───────────────────────────────────────────────

  it('read_task_history returns limited entries', async () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ task: `task-${i}`, warmth: 0.5 + i * 0.05, scores: { quality: i }, timestamp: `2026-03-24T0${i}:00:00Z` })
    );
    const jsonlData = lines.join('\n');

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(jsonlData);

    const result = await executor.execute({ tool: 'read_task_history', args: { agent_id: 'reviewer', limit: 3 } });

    expect(result.text).toContain('Task History: reviewer (last 3)');
    // Should contain only the last 3 entries (task-7, task-8, task-9)
    expect(result.text).toContain('task-7');
    expect(result.text).toContain('task-8');
    expect(result.text).toContain('task-9');
    // Should NOT contain earlier entries
    expect(result.text).not.toContain('task-0');
    expect(result.text).not.toContain('task-6');

    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
  });

  // ── plan happy path ─────────────────────────────────────────────────

  it('plan creates new pending plan', async () => {
    const mockDispatcher = {
      decompose: jest.fn().mockResolvedValue({
        originalTask: 'refactor auth module',
        subTasks: [
          { task: 'review current auth code', access: 'read' },
          { task: 'write new auth middleware', access: 'write' },
        ],
        strategy: 'sequential',
      }),
      assignAgents: jest.fn().mockReturnValue({
        originalTask: 'refactor auth module',
        subTasks: [
          { task: 'review current auth code', access: 'read', agentId: 'reviewer' },
          { task: 'write new auth middleware', access: 'write', agentId: 'writer' },
        ],
        strategy: 'sequential',
      }),
      classifyWriteModes: jest.fn().mockResolvedValue([
        { agentId: 'reviewer', task: 'review current auth code', access: 'read' },
        { agentId: 'writer', task: 'write new auth middleware', access: 'write', writeMode: 'sequential', scope: 'src/auth' },
      ]),
    };

    const planExecutor = new ToolExecutor({
      pipeline: mockPipeline,
      registry: mockRegistry,
      projectRoot: '/tmp/test-project',
      dispatcher: mockDispatcher,
    });

    const result = await planExecutor.execute({ tool: 'plan', args: { task: 'refactor auth module' } });

    expect(mockDispatcher.decompose).toHaveBeenCalledWith('refactor auth module');
    expect(mockDispatcher.assignAgents).toHaveBeenCalled();
    expect(mockDispatcher.classifyWriteModes).toHaveBeenCalled();
    expect(planExecutor.pendingPlan).not.toBeNull();
    expect(planExecutor.pendingPlan!.tasks).toHaveLength(2);
    expect(result.text).toContain('Plan: refactor auth module');
    expect(result.text).toContain('Strategy: sequential');
    expect(result.text).toContain('[reviewer]');
    expect(result.text).toContain('[writer]');
    expect(result.text).toContain('sequential: src/auth');
    expect(result.choices).toBeDefined();
    expect(result.choices!.options.some((o: any) => o.value === 'plan_execute')).toBe(true);
    expect(result.choices!.options.some((o: any) => o.value === 'plan_modify')).toBe(true);
    expect(result.choices!.options.some((o: any) => o.value === 'plan_cancel')).toBe(true);
  });

  // ── sequential plan execution ───────────────────────────────────────

  // ── init_project & update_team ─────────────────────────────────────

  it('init_project scans and proposes team', async () => {
    const mockInitializer = {
      scanDirectory: jest.fn().mockReturnValue({ dependencies: [], directories: [], files: [] }),
      proposeTeam: jest.fn().mockResolvedValue({ text: 'Proposed team...', choices: { message: 'Accept?', options: [] } }),
      pendingTask: null,
    };
    const exec = new ToolExecutor({
      pipeline: mockPipeline,
      registry: mockRegistry,
      projectRoot: '/tmp/test-project',
      initializer: mockInitializer,
    });
    await exec.execute({ tool: 'init_project', args: { description: 'build a game' } });
    expect(mockInitializer.scanDirectory).toHaveBeenCalled();
    expect(mockInitializer.proposeTeam).toHaveBeenCalledWith('build a game', expect.any(Object));
    expect(mockInitializer.pendingTask).toBe('build a game');
  });

  it('update_team add proposes via team manager', async () => {
    const mockTeamManager = {
      proposeAdd: jest.fn().mockReturnValue({ text: 'Add agent?', choices: { message: 'Confirm?', options: [] } }),
    };
    const exec = new ToolExecutor({
      pipeline: mockPipeline,
      registry: mockRegistry,
      projectRoot: '/tmp/test-project',
      teamManager: mockTeamManager,
    });
    const result = await exec.execute({ tool: 'update_team', args: { action: 'add', preset: 'reviewer', skills: ['security_audit'] } });
    expect(mockTeamManager.proposeAdd).toHaveBeenCalled();
    expect(result.choices).toBeDefined();
  });

  it('update_team remove proposes via team manager', async () => {
    const mockTeamManager = {
      proposeRemove: jest.fn().mockReturnValue({ text: 'Remove?', choices: { message: 'Confirm?', options: [] } }),
    };
    const exec = new ToolExecutor({
      pipeline: mockPipeline,
      registry: mockRegistry,
      projectRoot: '/tmp/test-project',
      teamManager: mockTeamManager,
    });
    await exec.execute({ tool: 'update_team', args: { action: 'remove', agent_id: 'gemini-reviewer' } });
    expect(mockTeamManager.proposeRemove).toHaveBeenCalledWith('gemini-reviewer');
  });

  it('init_project returns error when initializer not available', async () => {
    const result = await executor.execute({ tool: 'init_project', args: { description: 'test' } });
    expect(result.text).toContain('not available');
  });

  it('update_team returns error when team manager not available', async () => {
    const result = await executor.execute({ tool: 'update_team', args: { action: 'add' } });
    expect(result.text).toContain('not available');
  });

  it('executePlan sequential dispatches one at a time', async () => {
    let dispatchCallCount = 0;
    mockPipeline.dispatch.mockImplementation((_agentId: string, _task: string) => {
      dispatchCallCount++;
      return { taskId: `seq-task-${dispatchCallCount}` };
    });

    mockPipeline.collect
      .mockResolvedValueOnce({
        results: [{ agentId: 'reviewer', status: 'completed', result: 'Review complete' }],
      })
      .mockResolvedValueOnce({
        results: [{ agentId: 'writer', status: 'completed', result: 'Write complete' }],
      });

    const pending = {
      plan: {
        originalTask: 'sequential work',
        subTasks: [],
        strategy: 'sequential' as const,
      },
      tasks: [
        { agentId: 'reviewer', task: 'review first', access: 'read' as const },
        { agentId: 'writer', task: 'write second', access: 'write' as const },
      ],
    };

    const result = await executor.executePlan(pending);

    // dispatch called twice (once per task), not dispatchParallel
    expect(mockPipeline.dispatch).toHaveBeenCalledTimes(2);
    expect(mockPipeline.dispatchParallel).not.toHaveBeenCalled();

    // First dispatch with reviewer, second with writer
    expect(mockPipeline.dispatch).toHaveBeenNthCalledWith(1, 'reviewer', 'review first', undefined);
    expect(mockPipeline.dispatch).toHaveBeenNthCalledWith(2, 'writer', 'write second', undefined);

    // collect called once per task sequentially
    expect(mockPipeline.collect).toHaveBeenCalledTimes(2);
    expect(mockPipeline.collect).toHaveBeenNthCalledWith(1, ['seq-task-1'], 120_000);
    expect(mockPipeline.collect).toHaveBeenNthCalledWith(2, ['seq-task-2'], 120_000);

    expect(result.text).toContain('[reviewer] Review complete');
    expect(result.text).toContain('[writer] Write complete');
    expect(result.agents).toEqual(['reviewer', 'writer']);
  });
});
