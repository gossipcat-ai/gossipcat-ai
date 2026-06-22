"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('MemoryCompactor', () => {
    const testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-compactor-test-${Date.now()}`);
    const agentId = 'test-agent';
    const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
    const tasksPath = (0, path_1.join)(memDir, 'tasks.jsonl');
    const archivePath = (0, path_1.join)(memDir, 'archive.jsonl');
    beforeEach(() => {
        (0, fs_1.mkdirSync)(memDir, { recursive: true });
    });
    afterEach(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    function writeEntries(entries) {
        const lines = entries.map(e => JSON.stringify({
            version: 1,
            taskId: `t-${Math.random().toString(36).slice(2, 6)}`,
            task: e.task,
            skills: ['test'],
            findings: 1,
            hallucinated: 0,
            scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
            warmth: 0,
            importance: e.importance,
            timestamp: new Date(Date.now() - e.daysAgo * 86400000).toISOString(),
        })).join('\n') + '\n';
        (0, fs_1.writeFileSync)(tasksPath, lines);
    }
    it('does not compact when under threshold', () => {
        writeEntries([{ importance: 0.9, daysAgo: 0, task: 'recent task' }]);
        const compactor = new orchestrator_1.MemoryCompactor(testDir);
        const result = compactor.compactIfNeeded(agentId, 10);
        expect(result.archived).toBe(0);
    });
    it('archives coldest entries when over threshold', () => {
        writeEntries([
            { importance: 0.9, daysAgo: 0, task: 'hot task' },
            { importance: 0.1, daysAgo: 60, task: 'cold task 1' },
            { importance: 0.2, daysAgo: 45, task: 'cold task 2' },
            { importance: 0.8, daysAgo: 1, task: 'warm task' },
        ]);
        const compactor = new orchestrator_1.MemoryCompactor(testDir);
        const result = compactor.compactIfNeeded(agentId, 2);
        expect(result.archived).toBe(2);
        expect((0, fs_1.existsSync)(archivePath)).toBe(true);
        const remaining = (0, fs_1.readFileSync)(tasksPath, 'utf-8').trim().split('\n');
        expect(remaining).toHaveLength(2);
        const archived = (0, fs_1.readFileSync)(archivePath, 'utf-8').trim().split('\n');
        expect(archived).toHaveLength(2);
        const firstArchived = JSON.parse(archived[0]);
        expect(firstArchived.reason).toBe('warmth_below_threshold');
    });
    it('calculates warmth for entries', () => {
        const compactor = new orchestrator_1.MemoryCompactor(testDir);
        expect(compactor.calculateWarmth(0.9, new Date().toISOString())).toBeCloseTo(0.9, 1);
        const old = compactor.calculateWarmth(0.5, new Date(Date.now() - 30 * 86400000).toISOString());
        expect(old).toBeCloseTo(0.25, 1);
    });
});
//# sourceMappingURL=memory-compactor.test.js.map