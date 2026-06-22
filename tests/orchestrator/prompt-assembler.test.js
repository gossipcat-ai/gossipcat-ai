"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
describe('assemblePrompt', () => {
    it('assembles memory + skills', () => {
        const result = (0, orchestrator_1.assemblePrompt)({
            memory: 'memory content here',
            skills: 'skill content here',
        });
        expect(result).toContain('--- MEMORY ---');
        expect(result).toContain('memory content here');
        expect(result).toContain('--- END MEMORY ---');
        expect(result).toContain('--- SKILLS ---');
        expect(result).toContain('skill content here');
        expect(result).toContain('--- END SKILLS ---');
    });
    it('omits memory block when no memory', () => {
        const result = (0, orchestrator_1.assemblePrompt)({ skills: 'skills' });
        expect(result).not.toContain('--- MEMORY ---');
        expect(result).toContain('--- SKILLS ---');
    });
    it('omits lens block when no lens', () => {
        const result = (0, orchestrator_1.assemblePrompt)({ skills: 'skills', memory: 'mem' });
        expect(result).not.toContain('--- LENS ---');
    });
    it('includes lens block between memory and skills', () => {
        const result = (0, orchestrator_1.assemblePrompt)({
            memory: 'mem',
            lens: 'focus on DoS',
            skills: 'skills',
        });
        const memIdx = result.indexOf('--- END MEMORY ---');
        const lensIdx = result.indexOf('--- LENS ---');
        const skillsIdx = result.indexOf('--- SKILLS ---');
        expect(memIdx).toBeLessThan(lensIdx);
        expect(lensIdx).toBeLessThan(skillsIdx);
    });
    it('includes context after skills', () => {
        const result = (0, orchestrator_1.assemblePrompt)({ skills: 'skills', context: 'ctx' });
        expect(result).toContain('\n\nContext:\nctx');
    });
    it('handles all empty — returns empty string', () => {
        expect((0, orchestrator_1.assemblePrompt)({})).toBe('');
    });
    it('includes consensus summary instruction when consensusSummary is true', () => {
        const result = (0, orchestrator_1.assemblePrompt)({ consensusSummary: true });
        expect(result).toContain('## Consensus Summary');
        expect(result).toContain('one line per finding');
    });
    it('does not include consensus instruction when consensusSummary is false', () => {
        const result = (0, orchestrator_1.assemblePrompt)({});
        expect(result).not.toContain('## Consensus Summary');
    });
});
//# sourceMappingURL=prompt-assembler.test.js.map