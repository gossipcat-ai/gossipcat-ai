import { TaskDispatcher } from '../../packages/orchestrator/src/task-dispatcher';
import { AgentRegistry } from '../../packages/orchestrator/src/agent-registry';
import { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { DispatchPlan } from '../../packages/orchestrator/src/types';

describe('TaskDispatcher', () => {
  let llm: jest.Mocked<ILLMProvider>;
  let registry: AgentRegistry;
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    llm = {
      generate: jest.fn(),
    };
    // Simple registry with one agent for testing
    registry = new AgentRegistry();
    registry.register({ id: 'agent-1', provider: 'anthropic', model: 'claude-sonnet-4-6', skills: ['coding'] });

    dispatcher = new TaskDispatcher(llm, registry);
  });

  describe('decompose', () => {
    it('should fallback safely if LLM returns subtasks with missing descriptions', async () => {
      const malformedResponse = {
        strategy: 'single',
        subTasks: [{ requiredSkills: ['coding'] }], // Missing description
      };
      llm.generate.mockResolvedValue({ text: JSON.stringify(malformedResponse) });

      const plan = await dispatcher.decompose('test task');

      // LLM returned malformed subtask — decomposer should still produce a plan
      expect(plan.subTasks.length).toBeGreaterThanOrEqual(1);
      expect(plan.subTasks[0].id).toBeDefined();
    });

    it('should fallback safely if LLM returns subtasks that are not objects', async () => {
      const malformedResponse = {
        strategy: 'single',
        subTasks: [null, 'a string task'],
      };
      llm.generate.mockResolvedValue({ text: JSON.stringify(malformedResponse) });

      const plan = await dispatcher.decompose('test task');

      expect(plan.subTasks).toHaveLength(1);
      expect(plan.subTasks[0].description).toBe('test task');
    });

    it('should correctly parse JSON wrapped in markdown backticks', async () => {
      const validResponse = {
        strategy: 'single',
        subTasks: [{ description: 'do the thing', requiredSkills: ['coding'] }],
      };
      const responseText = 'Here is the plan:\n```json\n' + JSON.stringify(validResponse, null, 2) + '\n```';
      llm.generate.mockResolvedValue({ text: responseText });

      const plan = await dispatcher.decompose('test task');
      expect(plan.subTasks).toHaveLength(1);
      expect(plan.subTasks[0].description).toBe('do the thing');
    });
  });

  describe('classifyWriteModes', () => {
    it('should create tasks with valid agentIds', async () => {
        const plan: DispatchPlan = {
            originalTask: 'test',
            strategy: 'single',
            subTasks: [{
                id: 'sub-1',
                description: 'a task',
                requiredSkills: ['coding'],
                status: 'pending',
                assignedAgent: 'agent-1'
            }],
            warnings: [],
        };

        llm.generate.mockResolvedValue({ text: '[]' }); // Fallback is fine for this test

        const plannedTasks = await dispatcher.classifyWriteModes(plan);
        expect(plannedTasks[0].agentId).toBe('agent-1');
    });

    it('should handle subtask with no assigned agent gracefully', async () => {
      const planWithUnassignedTask: DispatchPlan = {
        originalTask: 'test',
        strategy: 'single',
        subTasks: [{
          id: 'sub-1',
          description: 'a task needing a skill nobody has',
          requiredSkills: ['unobtainium'],
          status: 'pending',
          // No assignedAgent
        }],
        warnings: [],
      };

      llm.generate.mockResolvedValue({ text: '[]' });
      const tasks = await dispatcher.classifyWriteModes(planWithUnassignedTask);
      // Unassigned agent produces empty agentId — caller must handle
      expect(tasks).toHaveLength(1);
      expect(tasks[0].agentId).toBe('');
    });

    it('should produce an empty agentId in the fallback case if a subtask is unassigned', async () => {
        const planWithUnassignedTask: DispatchPlan = {
            originalTask: 'test',
            strategy: 'single',
            subTasks: [{
                id: 'sub-1',
                description: 'a task needing a skill nobody has',
                requiredSkills: ['unobtainium'],
                status: 'pending',
            }],
            warnings: [],
        };

        // Trigger the catch block by returning malformed JSON
        llm.generate.mockResolvedValue({ text: 'not json' });

        const plannedTasks = await dispatcher.classifyWriteModes(planWithUnassignedTask);

        // This is the critical flaw: it should not create this invalid task
        expect(plannedTasks).toHaveLength(1);
        expect(plannedTasks[0].agentId).toBe('');
    });
  });

  describe('decomposeFromRaw (F17 + F9 — validation on untrusted input)', () => {
    it('falls back to a single task when the input is not JSON at all', () => {
      const plan = dispatcher.decomposeFromRaw('original task', 'this is definitely not json');
      expect(plan.strategy).toBe('single');
      expect(plan.subTasks).toHaveLength(1);
      expect(plan.subTasks[0].description).toBe('original task');
    });

    it('coerces unknown strategy values to "single"', () => {
      const raw = JSON.stringify({ strategy: 'maybe-parallel', subTasks: [{ description: 'do the thing' }] });
      const plan = dispatcher.decomposeFromRaw('original', raw);
      expect(plan.strategy).toBe('single');
      expect(plan.subTasks).toHaveLength(1);
      expect(plan.subTasks[0].description).toBe('do the thing');
    });

    it('accepts known strategies', () => {
      const raw = JSON.stringify({ strategy: 'parallel', subTasks: [{ description: 'a' }, { description: 'b' }] });
      const plan = dispatcher.decomposeFromRaw('original', raw);
      expect(plan.strategy).toBe('parallel');
      expect(plan.subTasks).toHaveLength(2);
    });

    it('drops subtasks with non-string or empty descriptions', () => {
      const raw = JSON.stringify({
        strategy: 'parallel',
        subTasks: [
          { description: 'valid' },
          { description: 42 },
          { description: '' },
          null,
          { description: '   ' },
        ],
      });
      const plan = dispatcher.decomposeFromRaw('original', raw);
      expect(plan.subTasks).toHaveLength(1);
      expect(plan.subTasks[0].description).toBe('valid');
    });

    it('falls back to single task when all subtasks are invalid', () => {
      const raw = JSON.stringify({ strategy: 'parallel', subTasks: [null, { description: 42 }] });
      const plan = dispatcher.decomposeFromRaw('original', raw);
      expect(plan.strategy).toBe('single');
      expect(plan.subTasks).toHaveLength(1);
      expect(plan.subTasks[0].description).toBe('original');
    });

    it('filters non-string requiredSkills', () => {
      const raw = JSON.stringify({
        strategy: 'single',
        subTasks: [{ description: 'a', requiredSkills: ['code', 42, null, 'review'] }],
      });
      const plan = dispatcher.decomposeFromRaw('original', raw);
      expect(plan.subTasks[0].requiredSkills).toEqual(['code', 'review']);
    });
  });
});
