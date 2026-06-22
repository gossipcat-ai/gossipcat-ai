"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('SkillGapTracker', () => {
    const testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-gap-tracker-test-${Date.now()}`);
    const gossipDir = (0, path_1.join)(testDir, '.gossip');
    const gapLogPath = (0, path_1.join)(gossipDir, 'skill-gaps.jsonl');
    const skillsDir = (0, path_1.join)(gossipDir, 'skills');
    beforeEach(() => {
        (0, fs_1.mkdirSync)(skillsDir, { recursive: true });
    });
    afterEach(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    function writeSuggestions(entries) {
        const lines = entries.map(e => JSON.stringify({ type: 'suggestion', skill: e.skill, reason: e.reason, agent: e.agent, task_context: 'test', timestamp: new Date().toISOString() })).join('\n') + '\n';
        (0, fs_1.writeFileSync)(gapLogPath, lines);
    }
    it('returns empty when gap log does not exist', () => {
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        expect(tracker.getPendingSkills()).toEqual([]);
    });
    it('does not trigger skeleton below threshold (2 suggestions, 1 agent)', () => {
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'r2' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        expect(tracker.shouldGenerate('dos_resilience')).toBe(false);
    });
    it('does not trigger skeleton below threshold (3 suggestions, 1 agent)', () => {
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'r2' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        expect(tracker.shouldGenerate('dos_resilience')).toBe(false);
    });
    it('triggers skeleton at threshold (3 suggestions, 2 agents)', () => {
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
            { skill: 'dos_resilience', agent: 'agent-2', reason: 'no rate limiting' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'unbounded queue' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        expect(tracker.shouldGenerate('dos_resilience')).toBe(true);
    });
    it('generates skeleton file with correct template', () => {
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
            { skill: 'dos_resilience', agent: 'agent-2', reason: 'no rate limiting' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'unbounded queue' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        const result = tracker.generateSkeleton('dos_resilience');
        expect(result.generated).toBe(true);
        expect(result.path).toBe((0, path_1.join)(skillsDir, 'dos-resilience.md'));
        expect((0, fs_1.existsSync)(result.path)).toBe(true);
        const content = (0, fs_1.readFileSync)(result.path, 'utf-8');
        expect(content).toContain('dos_resilience');
        expect(content).toContain('REVIEW AND EDIT BEFORE ASSIGNING');
        expect(content).toContain('no maxPayload');
        expect(content).toContain('no rate limiting');
    });
    it('appends resolution entry after generating skeleton', () => {
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
            { skill: 'dos_resilience', agent: 'agent-2', reason: 'r2' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        tracker.generateSkeleton('dos_resilience');
        const tracker2 = new orchestrator_1.SkillGapTracker(testDir);
        expect(tracker2.shouldGenerate('dos_resilience')).toBe(false);
    });
    it('getSuggestionsSince filters by agent and time', () => {
        const now = Date.now();
        const lines = [
            JSON.stringify({ type: 'suggestion', skill: 'a', reason: 'r', agent: 'agent-1', task_context: 'c', timestamp: new Date(now - 10000).toISOString() }),
            JSON.stringify({ type: 'suggestion', skill: 'b', reason: 'r', agent: 'agent-1', task_context: 'c', timestamp: new Date(now + 1000).toISOString() }),
            JSON.stringify({ type: 'suggestion', skill: 'c', reason: 'r', agent: 'agent-2', task_context: 'c', timestamp: new Date(now + 1000).toISOString() }),
        ].join('\n') + '\n';
        (0, fs_1.writeFileSync)(gapLogPath, lines);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        const results = tracker.getSuggestionsSince('agent-1', now);
        expect(results).toHaveLength(1);
        expect(results[0].skill).toBe('b');
    });
});
//# sourceMappingURL=skill-gap-tracker.test.js.map