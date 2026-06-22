"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
const skill_loader_1 = require("../../packages/orchestrator/src/skill-loader");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('SkillLoader', () => {
    it('loads default skills by name', () => {
        const content = (0, orchestrator_1.loadSkills)('test-agent', ['typescript'], process.cwd());
        expect(content).toContain('TypeScript');
        expect(content).toContain('SKILLS');
    });
    it('returns empty string for no skills', () => {
        expect((0, orchestrator_1.loadSkills)('test-agent', [], process.cwd())).toBe('');
    });
    it('returns empty for unknown skill', () => {
        expect((0, orchestrator_1.loadSkills)('test-agent', ['nonexistent-skill-xyz'], process.cwd())).toBe('');
    });
    it('lists available default skills', () => {
        const skills = (0, skill_loader_1.listAvailableSkills)('test-agent', process.cwd());
        expect(skills).toContain('typescript');
        expect(skills).toContain('code-review');
        expect(skills).toContain('debugging');
    });
    it('wraps multiple skills with delimiters', () => {
        const content = (0, orchestrator_1.loadSkills)('test-agent', ['typescript'], process.cwd());
        expect(content).toMatch(/^[\s\S]*--- SKILLS ---[\s\S]*--- END SKILLS ---[\s\S]*$/);
    });
    it('resolves underscore skill names to hyphenated filenames', () => {
        const tmpDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-test-${Date.now()}`);
        const skillDir = (0, path_1.join)(tmpDir, '.gossip', 'skills');
        (0, fs_1.mkdirSync)(skillDir, { recursive: true });
        (0, fs_1.writeFileSync)((0, path_1.join)(skillDir, 'code-review.md'), '# Code Review Skill');
        try {
            const result = (0, orchestrator_1.loadSkills)('test-agent', ['code_review'], tmpDir);
            expect(result).toContain('Code Review Skill');
        }
        finally {
            (0, fs_1.rmSync)(tmpDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=skill-loader.test.js.map