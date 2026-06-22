"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("@gossip/tools");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('SkillTools', () => {
    const testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-skill-tools-test-${Date.now()}`);
    const gossipDir = (0, path_1.join)(testDir, '.gossip');
    const gapLogPath = (0, path_1.join)(gossipDir, 'skill-gaps.jsonl');
    let skillTools;
    beforeEach(() => {
        (0, fs_1.mkdirSync)(gossipDir, { recursive: true });
        skillTools = new tools_1.SkillTools(testDir);
    });
    afterEach(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    it('creates gap log file and appends suggestion', async () => {
        const result = await skillTools.suggestSkill({
            skill_name: 'dos_resilience',
            reason: 'WebSocket has no maxPayload',
            task_context: 'Reviewing relay server',
        }, 'gemini-reviewer');
        expect(result).toContain('Suggestion noted');
        expect(result).toContain('dos_resilience');
        expect((0, fs_1.existsSync)(gapLogPath)).toBe(true);
        const lines = (0, fs_1.readFileSync)(gapLogPath, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]);
        expect(entry.type).toBe('suggestion');
        expect(entry.skill).toBe('dos_resilience');
        expect(entry.reason).toBe('WebSocket has no maxPayload');
        expect(entry.agent).toBe('gemini-reviewer');
        expect(entry.timestamp).toBeDefined();
    });
    it('appends multiple suggestions to same file', async () => {
        await skillTools.suggestSkill({ skill_name: 'a', reason: 'r1', task_context: 'c1' }, 'agent-1');
        await skillTools.suggestSkill({ skill_name: 'b', reason: 'r2', task_context: 'c2' }, 'agent-2');
        const lines = (0, fs_1.readFileSync)(gapLogPath, 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).skill).toBe('a');
        expect(JSON.parse(lines[1]).skill).toBe('b');
    });
    it('creates .gossip directory if it does not exist', async () => {
        (0, fs_1.rmSync)(gossipDir, { recursive: true, force: true });
        const freshTools = new tools_1.SkillTools(testDir);
        await freshTools.suggestSkill({ skill_name: 'x', reason: 'y', task_context: 'z' }, 'agent-1');
        expect((0, fs_1.existsSync)(gapLogPath)).toBe(true);
    });
    it('defaults agent to "unknown" when callerId not provided', async () => {
        await skillTools.suggestSkill({ skill_name: 'test', reason: 'reason', task_context: 'ctx' });
        const entry = JSON.parse((0, fs_1.readFileSync)(gapLogPath, 'utf-8').trim());
        expect(entry.agent).toBe('unknown');
    });
});
//# sourceMappingURL=skill-tools.test.js.map