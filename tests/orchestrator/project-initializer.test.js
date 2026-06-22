"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const path_2 = require("path");
const project_initializer_1 = require("../../packages/orchestrator/src/project-initializer");
const CATALOG_PATH = (0, path_2.resolve)(__dirname, '..', '..', 'data', 'archetypes.json');
function mockLLM(response) {
    return {
        generate: jest.fn().mockResolvedValue({ text: response }),
    };
}
function nullKeyProvider() {
    return Promise.resolve(null);
}
function allKeysProvider(provider) {
    return Promise.resolve(`fake-key-${provider}`);
}
function makeConfig(overrides = {}) {
    return {
        llm: mockLLM('{}'),
        projectRoot: '/tmp',
        keyProvider: allKeysProvider,
        catalogPath: CATALOG_PATH,
        ...overrides,
    };
}
describe('ProjectInitializer', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'gossip-test-'));
    });
    afterEach(() => {
        (0, fs_1.rmSync)(tmpDir, { recursive: true, force: true });
    });
    // ── scanDirectory ──────────────────────────────────────────────────────
    it('scanDirectory returns signals from package.json', () => {
        (0, fs_1.writeFileSync)((0, path_1.join)(tmpDir, 'package.json'), JSON.stringify({
            dependencies: { express: '^4.0.0', prisma: '^5.0.0' },
            devDependencies: { jest: '^29.0.0' },
        }));
        const init = new project_initializer_1.ProjectInitializer(makeConfig({ projectRoot: tmpDir }));
        const signals = init.scanDirectory(tmpDir);
        expect(signals.dependencies).toContain('express');
        expect(signals.dependencies).toContain('prisma');
        expect(signals.dependencies).toContain('jest');
        expect(signals.language).toBe('JavaScript');
        expect(signals.files).toContain('package.json');
    });
    it('scanDirectory detects TypeScript from tsconfig.json', () => {
        (0, fs_1.writeFileSync)((0, path_1.join)(tmpDir, 'tsconfig.json'), '{}');
        const init = new project_initializer_1.ProjectInitializer(makeConfig({ projectRoot: tmpDir }));
        const signals = init.scanDirectory(tmpDir);
        expect(signals.language).toBe('TypeScript');
        expect(signals.files).toContain('tsconfig.json');
    });
    it('scanDirectory skips symlinks', () => {
        // Create a real file somewhere, then symlink it
        const realDir = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'gossip-real-'));
        (0, fs_1.writeFileSync)((0, path_1.join)(realDir, 'tsconfig.json'), '{}');
        (0, fs_1.symlinkSync)((0, path_1.join)(realDir, 'tsconfig.json'), (0, path_1.join)(tmpDir, 'tsconfig.json'));
        const init = new project_initializer_1.ProjectInitializer(makeConfig({ projectRoot: tmpDir }));
        const signals = init.scanDirectory(tmpDir);
        expect(signals.language).toBeUndefined();
        expect(signals.files).not.toContain('tsconfig.json');
        (0, fs_1.rmSync)(realDir, { recursive: true, force: true });
    });
    it('scanDirectory returns empty signals for empty dir', () => {
        const init = new project_initializer_1.ProjectInitializer(makeConfig({ projectRoot: tmpDir }));
        const signals = init.scanDirectory(tmpDir);
        expect(signals.dependencies).toEqual([]);
        expect(signals.directories).toEqual([]);
        expect(signals.files).toEqual([]);
        expect(signals.language).toBeUndefined();
    });
    // ── proposeTeam ────────────────────────────────────────────────────────
    it('proposeTeam sends top candidates to LLM', async () => {
        const llm = mockLLM(JSON.stringify({
            archetype: 'api-backend',
            reason: 'Express + Prisma',
            main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
            agents: [{ id: 'google-implementer', provider: 'google', model: 'gemini-2.5-pro', preset: 'implementer', skills: [] }],
        }));
        const init = new project_initializer_1.ProjectInitializer(makeConfig({ llm, projectRoot: tmpDir }));
        const signals = { dependencies: ['express'], directories: [], files: [] };
        await init.proposeTeam('build an API', signals);
        expect(llm.generate).toHaveBeenCalledTimes(1);
        const callArgs = llm.generate.mock.calls[0];
        const systemMsg = callArgs[0].find((m) => m.role === 'system');
        expect(systemMsg.content).toContain('api-backend');
        expect(systemMsg.content).toContain('google, anthropic, openai');
    });
    it('proposeTeam returns error when no API keys', async () => {
        const init = new project_initializer_1.ProjectInitializer(makeConfig({ keyProvider: nullKeyProvider }));
        const signals = { dependencies: [], directories: [], files: [] };
        const result = await init.proposeTeam('test', signals);
        expect(result.text).toContain('No API keys available');
        expect(result.choices).toBeUndefined();
    });
    it('proposeTeam returns CHOICES with team proposal', async () => {
        const proposal = {
            archetype: 'full-stack',
            reason: 'Next.js project',
            main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
            agents: [
                { id: 'anthropic-architect', provider: 'anthropic', model: 'claude-sonnet-4-6', preset: 'architect', skills: ['system-design'] },
                { id: 'google-implementer', provider: 'google', model: 'gemini-2.5-flash', preset: 'implementer', skills: ['react'] },
            ],
        };
        const llm = mockLLM(JSON.stringify(proposal));
        const init = new project_initializer_1.ProjectInitializer(makeConfig({ llm }));
        const signals = { dependencies: ['next'], directories: ['pages/'], files: [] };
        const result = await init.proposeTeam('build a dashboard', signals);
        expect(result.text).toContain('full-stack');
        expect(result.text).toContain('anthropic-architect');
        expect(result.choices).toBeDefined();
        expect(result.choices.options).toHaveLength(4);
        expect(result.choices.options.map(o => o.value)).toEqual(['accept', 'modify', 'manual', 'skip']);
        expect(init.pendingProposal).toEqual(proposal);
        expect(init.pendingTask).toBe('build a dashboard');
    });
    // ── buildSignalSummary ─────────────────────────────────────────────────
    it('buildSignalSummary formats dependencies and dirs', () => {
        const init = new project_initializer_1.ProjectInitializer(makeConfig());
        const summary = init.buildSignalSummary({
            language: 'TypeScript',
            dependencies: ['express', 'prisma'],
            directories: ['src/', 'pages/'],
            files: ['Dockerfile', 'tsconfig.json'],
        });
        expect(summary).toContain('Language: TypeScript');
        expect(summary).toContain('Dependencies: express, prisma');
        expect(summary).toContain('Directories: src/, pages/');
        expect(summary).toContain('Files: Dockerfile, tsconfig.json');
    });
    it('buildSignalSummary omits empty sections', () => {
        const init = new project_initializer_1.ProjectInitializer(makeConfig());
        const summary = init.buildSignalSummary({
            language: 'Rust',
            dependencies: [],
            directories: [],
            files: ['Cargo.toml'],
        });
        expect(summary).toContain('Language: Rust');
        expect(summary).toContain('Files: Cargo.toml');
        expect(summary).not.toContain('Dependencies');
        expect(summary).not.toContain('Directories');
        expect(summary).not.toContain('Framework');
    });
});
//# sourceMappingURL=project-initializer.test.js.map