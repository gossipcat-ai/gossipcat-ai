"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('AgentMemoryReader', () => {
    const testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-memory-test-${Date.now()}`);
    const agentId = 'test-agent';
    const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
    const knowledgeDir = (0, path_1.join)(memDir, 'knowledge');
    beforeEach(() => {
        (0, fs_1.mkdirSync)(knowledgeDir, { recursive: true });
    });
    afterEach(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    it('returns null when MEMORY.md does not exist', () => {
        const reader = new orchestrator_1.AgentMemoryReader(testDir);
        expect(reader.loadMemory(agentId, 'some task')).toBeNull();
    });
    it('loads MEMORY.md content', () => {
        (0, fs_1.writeFileSync)((0, path_1.join)(memDir, 'MEMORY.md'), '# Agent Memory\n\n## Knowledge\n- test knowledge');
        const reader = new orchestrator_1.AgentMemoryReader(testDir);
        const result = reader.loadMemory(agentId, 'some task');
        expect(result).toContain('# Agent Memory');
        expect(result).toContain('test knowledge');
    });
    it('loads relevant knowledge files by keyword match', () => {
        (0, fs_1.writeFileSync)((0, path_1.join)(memDir, 'MEMORY.md'), '# Memory');
        (0, fs_1.writeFileSync)((0, path_1.join)(knowledgeDir, 'relay.md'), '---\nname: relay\ndescription: relay server internals\nimportance: 0.9\nlastAccessed: 2026-03-21\naccessCount: 5\n---\n\n- Auth via JSON frame\n- maxPayload 1MB');
        (0, fs_1.writeFileSync)((0, path_1.join)(knowledgeDir, 'unrelated.md'), '---\nname: unrelated\ndescription: database migrations\nimportance: 0.5\nlastAccessed: 2026-03-01\naccessCount: 1\n---\n\n- Use migrations');
        const reader = new orchestrator_1.AgentMemoryReader(testDir);
        const result = reader.loadMemory(agentId, 'review the relay server');
        expect(result).toContain('Auth via JSON frame');
        expect(result).not.toContain('database migrations');
    });
    it('calculates warmth correctly', () => {
        const reader = new orchestrator_1.AgentMemoryReader(testDir);
        // importance 0.9, accessed today
        expect(reader.calculateWarmth(0.9, new Date().toISOString())).toBeCloseTo(0.9, 1);
        // importance 0.5, accessed 30 days ago
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
        expect(reader.calculateWarmth(0.5, thirtyDaysAgo)).toBeCloseTo(0.25, 1);
    });
});
//# sourceMappingURL=agent-memory.test.js.map