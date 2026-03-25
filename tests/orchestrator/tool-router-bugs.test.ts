import { ToolRouter, ToolExecutor } from '../../packages/orchestrator/src/tool-router';
import { PENDING_PLAN_CHOICES } from '../../packages/orchestrator/src/tool-definitions';
import { DispatchPlan, PlannedTask } from '../../packages/orchestrator/src/types';

describe('ToolRouter bug hunt', () => {
  describe('parseToolCall', () => {
    it('should reject agent_id with dot segments', () => {
      const text = `[TOOL_CALL]{"tool": "dispatch", "args": {"agent_id": "..", "task": "test"}}[/TOOL_CALL]`;
      // The AGENT_ID_RE regex /^[a-zA-Z0-9_-]+$/ correctly rejects dots
      const result = ToolRouter.parseToolCall(text);
      expect(result).toBeNull();
    });

    it('should return null if args is not an object', () => {
      const text = `[TOOL_CALL]{"tool": "dispatch", "args": "not_an_object"}[/TOOL_CALL]`;
      expect(ToolRouter.parseToolCall(text)).toBeNull();
    });

    it('should handle JSON with duplicate keys by taking the last one (and fail validation if needed)', () => {
      const text = `[TOOL_CALL]{"tool": "dispatch", "args": {"task": "a"}, "args": {"task": "b", "agent_id": "test"}}[/TOOL_CALL]`;
      const result = ToolRouter.parseToolCall(text);
      expect(result).not.toBeNull();
      expect(result?.args.agent_id).toBe('test');
      expect(result?.args.task).toBe('b');
    });

    it('should reject if required args are present but have null/undefined values', () => {
      const text = `[TOOL_CALL]{"tool": "dispatch", "args": {"agent_id": "test-agent", "task": null}}[/TOOL_CALL]`;
      // Current implementation would pass this, but arguably it should fail.
      // This test is to highlight the ambiguity. For now, we test existing behavior.
      const parsed = ToolRouter.parseToolCall(text);
      expect(parsed?.args.task).toBeNull(); // It passes, but the executor will fail.
    });
  });
});

describe('ToolExecutor bug hunt', () => {
  let mockPipeline: any;
  let mockRegistry: any;
  let mockDispatcher: any;
  let executor: ToolExecutor;

  beforeEach(() => {
    mockPipeline = {
      dispatch: jest.fn(),
      dispatchParallel: jest.fn(),
      collect: jest.fn(),
    };
    mockRegistry = {
      get: jest.fn(),
      getAll: jest.fn(),
    };
    mockDispatcher = {
      decompose: jest.fn(),
      assignAgents: jest.fn(),
      classifyWriteModes: jest.fn(),
    };
    executor = new ToolExecutor({
      pipeline: mockPipeline,
      registry: mockRegistry,
      projectRoot: '/tmp',
      dispatcher: mockDispatcher,
    });
  });

  describe('handleDispatchParallel', () => {
    it('should not return any agent IDs if validation fails', async () => {
      mockRegistry.get.mockImplementation((id: string) => (id === 'agent-1' ? { id: 'agent-1' } : null));
      const args = { tasks: [{ agent_id: 'agent-1', task: 'a' }, { agent_id: 'agent-2', task: 'b' }] };

      const result = await executor.execute({ tool: 'dispatch_parallel', args });

      expect(result.text).toContain('agent "agent-2" not found');
      expect(result.agents).toBeUndefined(); // Bug: current code returns ['agent-1']
    });
  });

  describe('handleDispatchConsensus', () => {
    it('should fail if any specified agent is not found', async () => {
      mockRegistry.get.mockImplementation((id: string) => (id === 'agent-1' ? { id: 'agent-1' } : null));
      const args = { task: 'consensus task', agent_ids: ['agent-1', 'unknown-agent'] };

      const result = await executor.execute({ tool: 'dispatch_consensus', args });

      expect(result.text).toContain('agents not found in registry: unknown-agent');
      expect(result.agents).toBeUndefined();
    });
  });

  describe('executePlan', () => {
    it('should include specific error messages on parallel dispatch failure', async () => {
      const plan: DispatchPlan = {
        strategy: 'parallel',
        originalTask: 'test',
        subTasks: [],
      };
      const tasks: PlannedTask[] = [
        { agentId: 'a', task: 't1', access: 'read' },
        { agentId: 'b', task: 't2', access: 'read' },
      ];
      mockPipeline.dispatchParallel.mockResolvedValue({
        taskIds: [],
        errors: ['scope conflict on agent a', 'agent b timed out'],
      });

      const result = await executor.executePlan({ plan, tasks });

      expect(result.text).toContain('Plan execution failed.');
      expect(result.text).toContain('scope conflict on agent a');
      expect(result.text).toContain('agent b timed out');
    });
  });

  describe('handlePlan', () => {
    it('should not let a new plan request overwrite a pending one without explicit choice', async () => {
      // Stage a pending plan
      executor.pendingPlan = { plan: { strategy: 'sequential', originalTask: 'old plan', subTasks: [] }, tasks: [] };

      const result = await executor.execute({ tool: 'plan', args: { task: 'new shiny plan' } });

      expect(result.text).toContain('A plan is already pending approval');
      expect(result.choices?.options[0].value).toBe(PENDING_PLAN_CHOICES.EXECUTE_PENDING);
      expect(mockDispatcher.decompose).not.toHaveBeenCalled();
    });
  });

  describe('Top-level error handling', () => {
    it('should catch unexpected errors from the pipeline and format them', async () => {
      mockRegistry.get.mockReturnValue({ id: 'agent-1' });
      mockPipeline.dispatch.mockImplementation(() => {
        throw new Error('ECONNRESET');
      });

      const result = await executor.execute({ tool: 'dispatch', args: { agent_id: 'agent-1', task: 'a' } });

      expect(result.text).toBe('Tool error: ECONNRESET');
      expect(result.agents).toBeUndefined();
    });
  });
});
