"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Integration tests for the post-collect pipeline components:
 * MemoryWriter, MemoryCompactor, SkillGapTracker, assemblePrompt
 *
 * These mirror what gossip_collect does after a task completes,
 * tested against real file system (tmpdir).
 */
const orchestrator_1 = require("@gossip/orchestrator");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
// ── Shared setup helpers ───────────────────────────────────────────────────
function makeTestDir(label) {
    return (0, path_1.join)((0, os_1.tmpdir)(), `gossip-pipeline-test-${label}-${Date.now()}`);
}
// ── MemoryWriter: task entry + index ──────────────────────────────────────
describe('MemoryWriter — post-collect write + index', () => {
    let testDir;
    const agentId = 'gemini-reviewer';
    beforeEach(() => {
        testDir = makeTestDir('memwriter');
    });
    afterEach(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    it('writes task entry to tasks.jsonl after simulated task completion', async () => {
        const writer = new orchestrator_1.MemoryWriter(testDir);
        const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
        await writer.writeTaskEntry(agentId, {
            taskId: 'task-001',
            task: 'Review relay/server.ts for security issues',
            skills: ['security_audit'],
            scores: { relevance: 4, accuracy: 4, uniqueness: 3 },
        });
        expect((0, fs_1.existsSync)((0, path_1.join)(memDir, 'tasks.jsonl'))).toBe(true);
        const raw = (0, fs_1.readFileSync)((0, path_1.join)(memDir, 'tasks.jsonl'), 'utf-8').trim();
        const entry = JSON.parse(raw);
        expect(entry.taskId).toBe('task-001');
        expect(entry.task).toBe('Review relay/server.ts for security issues');
        expect(entry.skills).toContain('security_audit');
    });
    it('rebuilds MEMORY.md index after writing task entry', async () => {
        const writer = new orchestrator_1.MemoryWriter(testDir);
        const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
        await writer.writeTaskEntry(agentId, {
            taskId: 'task-002',
            task: 'Fix the auth bypass in the relay',
            skills: ['security_audit', 'code_review'],
            scores: { relevance: 5, accuracy: 4, uniqueness: 4 },
        });
        writer.rebuildIndex(agentId);
        const indexPath = (0, path_1.join)(memDir, 'MEMORY.md');
        expect((0, fs_1.existsSync)(indexPath)).toBe(true);
        const index = (0, fs_1.readFileSync)(indexPath, 'utf-8');
        expect(index).toContain(`# Agent Memory — ${agentId}`);
        expect(index).toContain('Fix the auth bypass in the relay');
    });
    it('accumulates multiple task entries and includes them all in the index', async () => {
        const writer = new orchestrator_1.MemoryWriter(testDir);
        const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
        await writer.writeTaskEntry(agentId, {
            taskId: 'task-A',
            task: 'First task',
            skills: ['code_review'],
            scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
        });
        await writer.writeTaskEntry(agentId, {
            taskId: 'task-B',
            task: 'Second task',
            skills: ['testing'],
            scores: { relevance: 4, accuracy: 4, uniqueness: 4 },
        });
        writer.rebuildIndex(agentId);
        const index = (0, fs_1.readFileSync)((0, path_1.join)(memDir, 'MEMORY.md'), 'utf-8');
        expect(index).toContain('First task');
        expect(index).toContain('Second task');
    });
});
// ── MemoryCompactor: archive cold entries ─────────────────────────────────
describe('MemoryCompactor — archive cold entries when over threshold', () => {
    let testDir;
    const agentId = 'gemini-reviewer';
    beforeEach(() => {
        testDir = makeTestDir('compactor');
        const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
        (0, fs_1.mkdirSync)(memDir, { recursive: true });
    });
    afterEach(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    function writeEntries(entries) {
        const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
        const lines = entries
            .map(e => JSON.stringify({
            version: 1,
            taskId: `t-${Math.random().toString(36).slice(2, 6)}`,
            task: e.task,
            skills: ['code_review'],
            findings: 1,
            hallucinated: 0,
            scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
            warmth: 0,
            importance: e.importance,
            timestamp: new Date(Date.now() - e.daysAgo * 86400000).toISOString(),
        }))
            .join('\n') + '\n';
        (0, fs_1.writeFileSync)((0, path_1.join)(memDir, 'tasks.jsonl'), lines);
    }
    it('does not compact when under threshold', () => {
        writeEntries([{ importance: 0.9, daysAgo: 0, task: 'recent hot task' }]);
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
        const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
        expect((0, fs_1.existsSync)((0, path_1.join)(memDir, 'archive.jsonl'))).toBe(true);
        const remaining = (0, fs_1.readFileSync)((0, path_1.join)(memDir, 'tasks.jsonl'), 'utf-8').trim().split('\n');
        expect(remaining).toHaveLength(2);
        const tasks = remaining.map(l => JSON.parse(l).task);
        expect(tasks).toContain('hot task');
        expect(tasks).toContain('warm task');
    });
    it('marks archived entries with warmth_below_threshold reason', () => {
        writeEntries([
            { importance: 0.9, daysAgo: 0, task: 'hot task' },
            { importance: 0.1, daysAgo: 60, task: 'cold task' },
            { importance: 0.8, daysAgo: 1, task: 'warm task' },
        ]);
        const compactor = new orchestrator_1.MemoryCompactor(testDir);
        compactor.compactIfNeeded(agentId, 1);
        const memDir = (0, path_1.join)(testDir, '.gossip', 'agents', agentId, 'memory');
        const archiveLines = (0, fs_1.readFileSync)((0, path_1.join)(memDir, 'archive.jsonl'), 'utf-8').trim().split('\n');
        const archived = JSON.parse(archiveLines[0]);
        expect(archived.reason).toBe('warmth_below_threshold');
    });
});
// ── SkillGapTracker: suggestions + skeleton generation ────────────────────
describe('SkillGapTracker — surfaces suggestions and generates skeletons', () => {
    let testDir;
    beforeEach(() => {
        testDir = makeTestDir('skillgap');
        const skillsDir = (0, path_1.join)(testDir, '.gossip', 'skills');
        (0, fs_1.mkdirSync)(skillsDir, { recursive: true });
    });
    afterEach(() => {
        (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
    });
    function writeSuggestions(entries) {
        const gapLogPath = (0, path_1.join)(testDir, '.gossip', 'skill-gaps.jsonl');
        const lines = entries
            .map(e => JSON.stringify({
            type: 'suggestion',
            skill: e.skill,
            reason: e.reason,
            agent: e.agent,
            task_context: 'test context',
            timestamp: new Date().toISOString(),
        }))
            .join('\n') + '\n';
        (0, fs_1.writeFileSync)(gapLogPath, lines);
    }
    it('returns empty when gap log does not exist', () => {
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        expect(tracker.getPendingSkills()).toEqual([]);
    });
    it('does not trigger skeleton generation below threshold', () => {
        // Only 2 suggestions from 1 agent — not enough
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no rate limiting' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        expect(tracker.shouldGenerate('dos_resilience')).toBe(false);
    });
    it('triggers skeleton generation at threshold (3 suggestions, 2 distinct agents)', () => {
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no rate limiting' },
            { skill: 'dos_resilience', agent: 'agent-2', reason: 'unbounded queue' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        expect(tracker.shouldGenerate('dos_resilience')).toBe(true);
    });
    it('generates skeleton file with reasons from suggestions', () => {
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no rate limiting' },
            { skill: 'dos_resilience', agent: 'agent-2', reason: 'unbounded queue' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        const result = tracker.generateSkeleton('dos_resilience');
        expect(result.generated).toBe(true);
        expect(result.path).toBeDefined();
        expect((0, fs_1.existsSync)(result.path)).toBe(true);
        const content = (0, fs_1.readFileSync)(result.path, 'utf-8');
        expect(content).toContain('dos_resilience');
        expect(content).toContain('REVIEW AND EDIT BEFORE ASSIGNING');
        expect(content).toContain('no rate limiting');
        expect(content).toContain('unbounded queue');
    });
    it('checkAndGenerate returns messages for skills at threshold', () => {
        writeSuggestions([
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no rate limiting' },
            { skill: 'dos_resilience', agent: 'agent-2', reason: 'unbounded queue' },
            { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
        ]);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        const messages = tracker.checkAndGenerate();
        expect(messages.length).toBeGreaterThanOrEqual(1);
        expect(messages[0]).toContain('dos_resilience');
    });
    it('getSuggestionsSince filters by agent and timestamp', () => {
        const now = Date.now();
        const gapLogPath = (0, path_1.join)(testDir, '.gossip', 'skill-gaps.jsonl');
        const lines = [
            JSON.stringify({ type: 'suggestion', skill: 'old_skill', reason: 'r', agent: 'agent-1', task_context: 'c', timestamp: new Date(now - 10000).toISOString() }),
            JSON.stringify({ type: 'suggestion', skill: 'new_skill', reason: 'r', agent: 'agent-1', task_context: 'c', timestamp: new Date(now + 1000).toISOString() }),
            JSON.stringify({ type: 'suggestion', skill: 'other_agent_skill', reason: 'r', agent: 'agent-2', task_context: 'c', timestamp: new Date(now + 1000).toISOString() }),
        ].join('\n') + '\n';
        (0, fs_1.writeFileSync)(gapLogPath, lines);
        const tracker = new orchestrator_1.SkillGapTracker(testDir);
        const results = tracker.getSuggestionsSince('agent-1', now);
        expect(results).toHaveLength(1);
        expect(results[0].skill).toBe('new_skill');
    });
});
// ── Prompt assembler: memory + skills combined ────────────────────────────
describe('assemblePrompt — combines memory and skills correctly', () => {
    it('combines agent memory and skills into a single prompt', () => {
        const result = (0, orchestrator_1.assemblePrompt)({
            memory: '## Recent Tasks\n- Reviewed relay/server.ts',
            skills: '# Security Audit\nCheck for OWASP Top 10 issues.',
        });
        expect(result).toContain('--- MEMORY ---');
        expect(result).toContain('## Recent Tasks');
        expect(result).toContain('--- END MEMORY ---');
        expect(result).toContain('--- SKILLS ---');
        expect(result).toContain('# Security Audit');
        expect(result).toContain('--- END SKILLS ---');
    });
    it('omits memory block when no memory is provided', () => {
        const result = (0, orchestrator_1.assemblePrompt)({
            skills: '# Code Review\nFind bugs and edge cases.',
        });
        expect(result).not.toContain('--- MEMORY ---');
        expect(result).toContain('--- SKILLS ---');
        expect(result).toContain('# Code Review');
    });
    it('returns empty string when nothing is provided', () => {
        expect((0, orchestrator_1.assemblePrompt)({})).toBe('');
    });
    it('memory block comes before skills block', () => {
        const result = (0, orchestrator_1.assemblePrompt)({
            memory: 'agent memory',
            skills: 'agent skills',
        });
        const memIdx = result.indexOf('--- MEMORY ---');
        const skillsIdx = result.indexOf('--- SKILLS ---');
        expect(memIdx).toBeLessThan(skillsIdx);
    });
    it('integrates real MemoryWriter output into assemblePrompt', async () => {
        const testDir = makeTestDir('prompt-integration');
        const agentId = 'test-agent';
        try {
            const writer = new orchestrator_1.MemoryWriter(testDir);
            await writer.writeTaskEntry(agentId, {
                taskId: 'task-x',
                task: 'Review the relay server for bugs',
                skills: ['code_review'],
                scores: { relevance: 4, accuracy: 4, uniqueness: 3 },
            });
            writer.rebuildIndex(agentId);
            const reader = new orchestrator_1.AgentMemoryReader(testDir);
            const memory = reader.loadMemory(agentId, 'Review relay server');
            const prompt = (0, orchestrator_1.assemblePrompt)({
                memory: memory || undefined,
                skills: '# Code Review\nLook for bugs.',
            });
            expect(prompt).toContain('--- MEMORY ---');
            expect(prompt).toContain('--- SKILLS ---');
            expect(prompt).toContain('# Code Review');
        }
        finally {
            (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=post-collect-pipeline.test.js.map