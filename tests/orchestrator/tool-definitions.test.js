"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tool_definitions_1 = require("../../packages/orchestrator/src/tool-definitions");
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
    it('has exactly 11 tool schemas', () => {
        expect(Object.keys(tool_definitions_1.TOOL_SCHEMAS)).toHaveLength(11);
    });
    it.each(EXPECTED_TOOLS)('has schema for %s with description and requiredArgs', (tool) => {
        const schema = tool_definitions_1.TOOL_SCHEMAS[tool];
        expect(schema).toBeDefined();
        expect(typeof schema.description).toBe('string');
        expect(schema.description.length).toBeGreaterThan(0);
        expect(Array.isArray(schema.requiredArgs)).toBe(true);
    });
    it('does not include a chat tool', () => {
        expect(tool_definitions_1.TOOL_SCHEMAS['chat']).toBeUndefined();
    });
    describe('PLAN_CHOICES', () => {
        it('has EXECUTE, MODIFY, CANCEL', () => {
            expect(tool_definitions_1.PLAN_CHOICES.EXECUTE).toBe('plan_execute');
            expect(tool_definitions_1.PLAN_CHOICES.MODIFY).toBe('plan_modify');
            expect(tool_definitions_1.PLAN_CHOICES.CANCEL).toBe('plan_cancel');
        });
    });
    describe('PENDING_PLAN_CHOICES', () => {
        it('has DISCARD, EXECUTE_PENDING, CANCEL', () => {
            expect(tool_definitions_1.PENDING_PLAN_CHOICES.DISCARD).toBe('discard_and_replan');
            expect(tool_definitions_1.PENDING_PLAN_CHOICES.EXECUTE_PENDING).toBe('execute_pending');
            expect(tool_definitions_1.PENDING_PLAN_CHOICES.CANCEL).toBe('cancel');
        });
    });
    describe('buildToolSystemPrompt', () => {
        const agents = [
            { id: 'reviewer', preset: 'code-review', skills: ['typescript'] },
            { id: 'writer', skills: ['typescript', 'testing'] },
        ];
        const prompt = (0, tool_definitions_1.buildToolSystemPrompt)(agents);
        it('contains all tool names', () => {
            for (const tool of EXPECTED_TOOLS) {
                expect(prompt).toContain(tool);
            }
        });
        it('contains [TOOL_CALL] format', () => {
            expect(prompt).toContain('[TOOL_CALL]');
        });
        it('contains [CHOICES] format', () => {
            expect(prompt).toContain('[CHOICES]');
        });
        it('references team context instead of duplicating agent list', () => {
            expect(prompt).toContain('See the team context above');
        });
    });
});
//# sourceMappingURL=tool-definitions.test.js.map