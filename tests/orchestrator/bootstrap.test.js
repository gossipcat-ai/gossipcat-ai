"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('BootstrapGenerator', () => {
    const testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-bootstrap-test-${Date.now()}`);
    afterAll(() => { (0, fs_1.rmSync)(testDir, { recursive: true, force: true }); });
    describe('tier detection', () => {
        it('returns no-config tier when no config exists', () => {
            const dir = (0, path_1.join)(testDir, 'empty');
            (0, fs_1.mkdirSync)(dir, { recursive: true });
            const gen = new orchestrator_1.BootstrapGenerator(dir);
            const result = gen.generate();
            expect(result.tier).toBe('no-config');
            expect(result.agentCount).toBe(0);
            expect(result.prompt).toContain('not configured yet');
        });
        it('returns no-memory tier when config exists but no memory', () => {
            const dir = (0, path_1.join)(testDir, 'config-only');
            (0, fs_1.mkdirSync)((0, path_1.join)(dir, '.gossip'), { recursive: true });
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.gossip', 'config.json'), JSON.stringify({
                main_agent: { provider: 'local', model: 'qwen' },
                agents: { 'test-agent': { provider: 'local', model: 'qwen', skills: ['testing'] } }
            }));
            const gen = new orchestrator_1.BootstrapGenerator(dir);
            const result = gen.generate();
            expect(result.tier).toBe('no-memory');
            expect(result.agentCount).toBe(1);
            expect(result.prompt).toContain('test-agent');
            expect(result.prompt).toContain('No task history yet');
        });
        it('returns full tier when config and memory exist', () => {
            const dir = (0, path_1.join)(testDir, 'full');
            (0, fs_1.mkdirSync)((0, path_1.join)(dir, '.gossip', 'agents', 'test-agent', 'memory'), { recursive: true });
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.gossip', 'config.json'), JSON.stringify({
                main_agent: { provider: 'local', model: 'qwen' },
                agents: { 'test-agent': { provider: 'local', model: 'qwen', preset: 'reviewer', skills: ['testing', 'code_review'] } }
            }));
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.gossip', 'agents', 'test-agent', 'memory', 'tasks.jsonl'), '{"version":1,"taskId":"t1","task":"review code","skills":["testing"],"findings":0,"hallucinated":0,"scores":{"relevance":3,"accuracy":3,"uniqueness":3},"warmth":1,"importance":0.6,"timestamp":"2026-03-22T10:00:00Z"}\n' +
                '{"version":1,"taskId":"t2","task":"check tests","skills":["testing"],"findings":0,"hallucinated":0,"scores":{"relevance":3,"accuracy":3,"uniqueness":3},"warmth":1,"importance":0.6,"timestamp":"2026-03-22T11:00:00Z"}\n');
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.gossip', 'agents', 'test-agent', 'memory', 'MEMORY.md'), '# Agent Memory — test-agent\n\n## Knowledge\n- [security](knowledge/security.md) — relay auth patterns\n\n## Recent Tasks\n- 2026-03-22: review code\n');
            const gen = new orchestrator_1.BootstrapGenerator(dir);
            const result = gen.generate();
            expect(result.tier).toBe('full');
            expect(result.agentCount).toBe(1);
            expect(result.prompt).toContain('test-agent');
            expect(result.prompt).toContain('2 tasks');
            expect(result.prompt).toContain('Dispatch Rules');
        });
    });
    describe('error handling', () => {
        it('falls back to no-config on malformed config JSON', () => {
            const dir = (0, path_1.join)(testDir, 'bad-json');
            (0, fs_1.mkdirSync)((0, path_1.join)(dir, '.gossip'), { recursive: true });
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.gossip', 'config.json'), '{ broken json!!!');
            const gen = new orchestrator_1.BootstrapGenerator(dir);
            const result = gen.generate();
            expect(result.tier).toBe('no-config');
        });
        it('shows no task history when tasks.jsonl has malformed lines', () => {
            const dir = (0, path_1.join)(testDir, 'bad-tasks');
            (0, fs_1.mkdirSync)((0, path_1.join)(dir, '.gossip', 'agents', 'a1', 'memory'), { recursive: true });
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.gossip', 'config.json'), JSON.stringify({
                main_agent: { provider: 'local', model: 'q' },
                agents: { 'a1': { provider: 'local', model: 'q', skills: ['testing'] } }
            }));
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.gossip', 'agents', 'a1', 'memory', 'tasks.jsonl'), 'NOT JSON\n{"version":1,"taskId":"ok","task":"t","skills":[],"findings":0,"hallucinated":0,"scores":{"relevance":3,"accuracy":3,"uniqueness":3},"warmth":1,"importance":0.6,"timestamp":"2026-03-22T00:00:00Z"}\nALSO BAD\n');
            const gen = new orchestrator_1.BootstrapGenerator(dir);
            const result = gen.generate();
            expect(result.prompt).toContain('1 tasks'); // only the valid line counted
        });
    });
    describe('config migration', () => {
        it('copies gossip.agents.json to .gossip/config.json on first run', () => {
            const dir = (0, path_1.join)(testDir, 'migrate');
            (0, fs_1.mkdirSync)(dir, { recursive: true });
            const config = { main_agent: { provider: 'local', model: 'q' }, agents: { 'a1': { provider: 'local', model: 'q', skills: ['t'] } } };
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, 'gossip.agents.json'), JSON.stringify(config));
            const gen = new orchestrator_1.BootstrapGenerator(dir);
            gen.generate();
            expect((0, fs_1.existsSync)((0, path_1.join)(dir, '.gossip', 'config.json'))).toBe(true);
            expect((0, fs_1.existsSync)((0, path_1.join)(dir, 'gossip.agents.json'))).toBe(true); // old file preserved
        });
        it('does not overwrite existing .gossip/config.json', () => {
            const dir = (0, path_1.join)(testDir, 'no-overwrite');
            (0, fs_1.mkdirSync)((0, path_1.join)(dir, '.gossip'), { recursive: true });
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.gossip', 'config.json'), '{"new": true}');
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, 'gossip.agents.json'), '{"old": true}');
            const gen = new orchestrator_1.BootstrapGenerator(dir);
            gen.generate(); // should NOT overwrite
            const content = (0, fs_1.readFileSync)((0, path_1.join)(dir, '.gossip', 'config.json'), 'utf-8');
            expect(content).toContain('"new"');
        });
    });
});
//# sourceMappingURL=bootstrap.test.js.map