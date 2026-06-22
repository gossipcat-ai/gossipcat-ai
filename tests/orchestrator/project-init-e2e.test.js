"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Project Init E2E Test
 *
 * Verifies that ProjectInitializer correctly:
 * 1. Scans a directory with game signals
 * 2. Proposes a game-dev team via real LLM
 * 3. Returns a valid team proposal
 *
 * Run: npx jest tests/orchestrator/project-init-e2e.test.ts --testTimeout=120000 --verbose
 */
const project_initializer_1 = require("../../packages/orchestrator/src/project-initializer");
const src_1 = require("../../packages/orchestrator/src");
const fs_1 = require("fs");
const path_1 = require("path");
const child_process_1 = require("child_process");
const os_1 = require("os");
function getKeyFromKeychain(provider) {
    try {
        return (0, child_process_1.execFileSync)('security', [
            'find-generic-password', '-s', 'gossip-mesh', '-a', provider, '-w'
        ], { stdio: 'pipe' }).toString().trim();
    }
    catch {
        return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || null;
    }
}
describe('Project Init E2E', () => {
    let testDir;
    let initializer;
    beforeAll(() => {
        const apiKey = getKeyFromKeychain('google');
        if (!apiKey)
            throw new Error('Need Google API key for E2E test');
        const llm = (0, src_1.createProvider)('google', 'gemini-2.5-pro', apiKey);
        // Create temp project dir with game signals
        testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-test-${Date.now()}`);
        (0, fs_1.mkdirSync)(testDir, { recursive: true });
        (0, fs_1.mkdirSync)((0, path_1.join)(testDir, 'assets'), { recursive: true });
        (0, fs_1.mkdirSync)((0, path_1.join)(testDir, 'src'), { recursive: true });
        (0, fs_1.writeFileSync)((0, path_1.join)(testDir, 'package.json'), JSON.stringify({
            name: 'snake-game',
            dependencies: { 'blessed': '^0.1.0' },
            devDependencies: { 'typescript': '^5.0.0' },
        }));
        (0, fs_1.writeFileSync)((0, path_1.join)(testDir, 'tsconfig.json'), '{}');
        initializer = new project_initializer_1.ProjectInitializer({
            llm,
            projectRoot: testDir,
            keyProvider: async (provider) => getKeyFromKeychain(provider),
        });
    });
    afterAll(() => {
        if (testDir && (0, fs_1.existsSync)(testDir)) {
            (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
        }
    });
    it('should scan directory and detect game signals', () => {
        const signals = initializer.scanDirectory(testDir);
        console.log('Signals:', JSON.stringify(signals, null, 2));
        expect(signals.language).toBe('TypeScript');
        expect(signals.dependencies).toContain('blessed');
        expect(signals.directories).toContain('assets/');
        expect(signals.files).toContain('package.json');
    });
    it('should propose a game-dev team from real LLM', async () => {
        const signals = initializer.scanDirectory(testDir);
        const result = await initializer.proposeTeam('Build a terminal snake game in TypeScript with keyboard input and score tracking', signals);
        console.log('\n=== Team Proposal ===');
        console.log(result.text);
        expect(result.text).toBeTruthy();
        expect(result.text.length).toBeGreaterThan(50);
        // Should have choices for approval
        expect(result.choices).toBeDefined();
    }, 60_000);
    it('should write config after approval', async () => {
        // Only run if proposeTeam stored a proposal
        if (!initializer.pendingProposal) {
            // Re-run proposeTeam to populate pendingProposal
            const signals = initializer.scanDirectory(testDir);
            await initializer.proposeTeam('Build a terminal snake game in TypeScript', signals);
        }
        if (initializer.pendingProposal) {
            await initializer.writeConfig(testDir);
            const configPath = (0, path_1.join)(testDir, '.gossip', 'config.json');
            expect((0, fs_1.existsSync)(configPath)).toBe(true);
            const config = JSON.parse((0, fs_1.readFileSync)(configPath, 'utf-8'));
            console.log('\n=== Written Config ===');
            console.log(JSON.stringify(config, null, 2));
            expect(config.project).toBeDefined();
            expect(config.project.archetype).toBeTruthy();
            expect(config.agents).toBeDefined();
            expect(Object.keys(config.agents).length).toBeGreaterThan(0);
        }
        else {
            console.log('Skipped: no pending proposal (LLM may have asked for clarification)');
        }
    }, 60_000);
});
//# sourceMappingURL=project-init-e2e.test.js.map