import {
  TOOL_SCHEMAS,
  PLAN_CHOICES,
  PENDING_PLAN_CHOICES,
  buildToolSystemPrompt,
} from '../../packages/orchestrator/src/tool-definitions';

describe('Tool Definitions', () => {
  const EXPECTED_TOOLS = [
    'dispatch',
    'dispatch_parallel',
    'dispatch_consensus',
    'plan',
    'agents',
    'agent_status',
    'agent_performance',
    'update_instructions',
    'read_task_history',
    'init_project',
    'update_team',
  ];

  it('has exactly 13 tool schemas', () => {
    expect(Object.keys(TOOL_SCHEMAS)).toHaveLength(13);
  });

  it.each(EXPECTED_TOOLS)('has schema for %s with description and requiredArgs', (tool) => {
    const schema = TOOL_SCHEMAS[tool];
    expect(schema).toBeDefined();
    expect(typeof schema.description).toBe('string');
    expect(schema.description.length).toBeGreaterThan(0);
    expect(Array.isArray(schema.requiredArgs)).toBe(true);
  });

  it('does not include a chat tool', () => {
    expect(TOOL_SCHEMAS['chat']).toBeUndefined();
  });

  describe('PLAN_CHOICES', () => {
    it('has EXECUTE, MODIFY, CANCEL', () => {
      expect(PLAN_CHOICES.EXECUTE).toBe('plan_execute');
      expect(PLAN_CHOICES.MODIFY).toBe('plan_modify');
      expect(PLAN_CHOICES.CANCEL).toBe('plan_cancel');
    });
  });

  describe('PENDING_PLAN_CHOICES', () => {
    it('has DISCARD, EXECUTE_PENDING, CANCEL', () => {
      expect(PENDING_PLAN_CHOICES.DISCARD).toBe('discard_and_replan');
      expect(PENDING_PLAN_CHOICES.EXECUTE_PENDING).toBe('execute_pending');
      expect(PENDING_PLAN_CHOICES.CANCEL).toBe('cancel');
    });
  });

  describe('buildToolSystemPrompt', () => {
    const agents = [
      { id: 'reviewer', preset: 'code-review', skills: ['typescript'] },
      { id: 'writer', skills: ['typescript', 'testing'] },
    ];
    const prompt = buildToolSystemPrompt(agents);

    it('contains all tool names', () => {
      for (const tool of EXPECTED_TOOLS) {
        expect(prompt).toContain(tool);
      }
    });

    it('contains tool call format instruction', () => {
      expect(prompt).toContain('[TOOL_CALL]');
    });

    it('lists agent IDs', () => {
      expect(prompt).toContain('reviewer');
      expect(prompt).toContain('writer');
    });
  });
});
