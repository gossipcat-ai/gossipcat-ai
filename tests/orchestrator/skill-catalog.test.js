"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
describe('SkillCatalog', () => {
    const catalog = new orchestrator_1.SkillCatalog();
    it('loads catalog from default-skills directory', () => {
        const skills = catalog.listSkills();
        expect(skills.length).toBeGreaterThan(0);
        expect(skills.find(s => s.name === 'security_audit')).toBeDefined();
        expect(skills.find(s => s.name === 'code_review')).toBeDefined();
    });
    it('matches task text against skill keywords', () => {
        const matches = catalog.matchTask('review this WebSocket server for DoS vulnerabilities');
        const names = matches.map(m => m.name);
        expect(names).toContain('security_audit');
    });
    it('returns empty array for task with no keyword matches', () => {
        const matches = catalog.matchTask('hello world');
        expect(matches).toEqual([]);
    });
    it('checks skill coverage for an agent', () => {
        const agentSkills = ['code_review', 'debugging'];
        const warnings = catalog.checkCoverage(agentSkills, 'review this code for security vulnerabilities and injection attacks');
        expect(warnings.some(w => w.includes('security_audit'))).toBe(true);
    });
    it('returns no warnings when agent covers all matched skills', () => {
        const agentSkills = ['security_audit', 'code_review', 'implementation'];
        const warnings = catalog.checkCoverage(agentSkills, 'review this code for security vulnerabilities');
        expect(warnings).toEqual([]);
    });
    it('validates catalog against skill files', () => {
        const issues = catalog.validate();
        expect(issues).toEqual([]);
    });
});
//# sourceMappingURL=skill-catalog.test.js.map