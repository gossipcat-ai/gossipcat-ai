"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('MemoryWriter', () => {
    const testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-memwriter-test-${Date.now()}`);
    const agentId = 'test-agent';
    const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
    afterEach(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    it('creates directory structure on first write', async () => {
        const writer = new orchestrator_1.MemoryWriter(testDir);
        await writer.writeTaskEntry(agentId, {
            taskId: 'abc',
            task: 'review code',
            skills: ['code_review'],
            scores: { relevance: 4, accuracy: 3, uniqueness: 5 },
        });
        expect((0, fs_1.existsSync)((0, path_1.join)(memDir, 'tasks.jsonl'))).toBe(true);
        expect((0, fs_1.existsSync)((0, path_1.join)(memDir, 'knowledge'))).toBe(true);
        expect((0, fs_1.existsSync)((0, path_1.join)(memDir, 'calibration'))).toBe(true);
    });
    it('appends task entry to tasks.jsonl', async () => {
        const writer = new orchestrator_1.MemoryWriter(testDir);
        await writer.writeTaskEntry(agentId, {
            taskId: 'abc',
            task: 'review relay/server.ts for security issues',
            skills: ['security_audit'],
            scores: { relevance: 4, accuracy: 3, uniqueness: 5 },
        });
        const content = (0, fs_1.readFileSync)((0, path_1.join)(memDir, 'tasks.jsonl'), 'utf-8');
        const entry = JSON.parse(content.trim());
        expect(entry.version).toBe(1);
        expect(entry.taskId).toBe('abc');
        expect(entry.task).toBe('review relay/server.ts for security issues');
        expect(entry.scores.relevance).toBe(4);
        expect(entry.importance).toBeCloseTo(0.8, 1);
        expect(entry.warmth).toBe(1.0);
    });
    it('rebuilds MEMORY.md index with recent tasks', async () => {
        const writer = new orchestrator_1.MemoryWriter(testDir);
        await writer.writeTaskEntry(agentId, {
            taskId: 'a1', task: 'first task', skills: ['code_review'],
            scores: { relevance: 4, accuracy: 4, uniqueness: 4 },
        });
        await writer.writeTaskEntry(agentId, {
            taskId: 'a2', task: 'second task', skills: ['testing'],
            scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
        });
        writer.rebuildIndex(agentId);
        const index = (0, fs_1.readFileSync)((0, path_1.join)(memDir, 'MEMORY.md'), 'utf-8');
        expect(index).toContain(`# Agent Memory — ${agentId}`);
        expect(index).toContain('second task');
        expect(index).toContain('first task');
    });
    it('derives importance from scores via writeTaskEntry', async () => {
        const writer = new orchestrator_1.MemoryWriter(testDir);
        await writer.writeTaskEntry('test-agent', {
            taskId: 'imp-test', task: 'test importance', skills: ['testing'],
            scores: { relevance: 5, accuracy: 5, uniqueness: 5 },
        });
        const tasksPath = (0, path_1.join)(testDir, '.gossip', 'agents', 'test-agent', 'memory', 'tasks.jsonl');
        const entry = JSON.parse((0, fs_1.readFileSync)(tasksPath, 'utf-8').trim());
        expect(entry.importance).toBe(1.0); // (5+5+5)/15 = 1.0
    });
});
//# sourceMappingURL=memory-writer.test.js.map