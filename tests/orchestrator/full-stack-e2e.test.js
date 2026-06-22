"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Full-Stack E2E Test — Project Init → Agent Dispatch → Code Output
 *
 * Boots the ENTIRE gossipcat stack (relay, tool server, workers) and simulates
 * a real user session: create a new project → init proposes team → accept →
 * agents actually execute tasks → verify output.
 *
 * This is the closest we can get to testing the interactive chat without a terminal.
 *
 * Run: npx jest tests/orchestrator/full-stack-e2e.test.ts --testTimeout=600000 --verbose
 */
const src_1 = require("../../packages/orchestrator/src");
const src_2 = require("../../packages/relay/src");
const src_3 = require("../../packages/tools/src");
const fs_1 = require("fs");
const path_1 = require("path");
const child_process_1 = require("child_process");
const os_1 = require("os");
function getKey(provider) {
    try {
        return (0, child_process_1.execFileSync)('security', [
            'find-generic-password', '-s', 'gossip-mesh', '-a', provider, '-w'
        ], { stdio: 'pipe' }).toString().trim();
    }
    catch {
        return null;
    }
}
describe('Full-Stack E2E — New Project Flow', () => {
    let testDir;
    let relay;
    let toolServer;
    let mainAgent;
    beforeAll(async () => {
        const googleKey = getKey('google');
        if (!googleKey)
            throw new Error('Need Google API key for full-stack E2E');
        // Create temp project directory with game signals
        testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-fullstack-${Date.now()}`);
        (0, fs_1.mkdirSync)((0, path_1.join)(testDir, 'src'), { recursive: true });
        (0, fs_1.mkdirSync)((0, path_1.join)(testDir, 'assets'), { recursive: true });
        (0, fs_1.writeFileSync)((0, path_1.join)(testDir, 'package.json'), JSON.stringify({
            name: 'snake-game',
            dependencies: { blessed: '^0.1.81' },
            devDependencies: { typescript: '^5.7.0' },
        }));
        (0, fs_1.writeFileSync)((0, path_1.join)(testDir, 'tsconfig.json'), '{}');
        // Boot relay
        relay = new src_2.RelayServer({ port: 0 });
        await relay.start();
        console.log(`Relay started on port ${relay.port}`);
        // Boot tool server
        toolServer = new src_3.ToolServer({ relayUrl: relay.url, projectRoot: testDir });
        await toolServer.start();
        console.log('Tool server started');
        // Create MainAgent with NO agents (triggers init flow)
        const llm = (0, src_1.createProvider)('google', 'gemini-2.5-pro', googleKey);
        mainAgent = new src_1.MainAgent({
            provider: 'google',
            model: 'gemini-2.5-pro',
            relayUrl: relay.url,
            agents: [], // Empty — triggers project init
            projectRoot: testDir,
            llm,
            keyProvider: async (provider) => getKey(provider),
            toolServer: {
                assignScope: (agentId, scope) => toolServer.assignScope(agentId, scope),
                assignRoot: (agentId, root) => toolServer.assignRoot(agentId, root),
                releaseAgent: (agentId) => toolServer.releaseAgent(agentId),
            },
        });
        // Don't call start() yet — no agents to start workers for
    }, 30_000);
    afterAll(async () => {
        if (mainAgent)
            await mainAgent.stop();
        if (toolServer)
            await toolServer.stop();
        if (relay)
            await relay.stop();
        if (testDir && (0, fs_1.existsSync)(testDir)) {
            (0, fs_1.rmSync)(testDir, { recursive: true, force: true });
        }
    });
    it('Step 1: First message triggers project init with team proposal', async () => {
        console.log('\n=== Step 1: First message ===');
        const response = await mainAgent.handleMessage('build a terminal snake game in TypeScript with keyboard input and score tracking');
        console.log('Response:', response.text.slice(0, 500));
        console.log('Choices:', response.choices?.options.map(o => o.value));
        expect(response.text).toBeTruthy();
        expect(response.choices).toBeDefined();
        expect(response.choices.options.some(o => o.value === 'accept')).toBe(true);
    }, 60_000);
    it('Step 2: Accept team → config written → workers started', async () => {
        console.log('\n=== Step 2: Accept team ===');
        const response = await mainAgent.handleChoice('build a terminal snake game in TypeScript', 'accept');
        console.log('Response:', response.text?.slice(0, 500));
        // Config should be written
        const configPath = (0, path_1.join)(testDir, '.gossip', 'config.json');
        expect((0, fs_1.existsSync)(configPath)).toBe(true);
        const config = JSON.parse((0, fs_1.readFileSync)(configPath, 'utf-8'));
        console.log('Archetype:', config.project?.archetype);
        console.log('Agents:', Object.keys(config.agents || {}));
        expect(config.project?.archetype).toBeTruthy();
        expect(Object.keys(config.agents || {}).length).toBeGreaterThan(0);
    }, 120_000);
    it('Step 3: Follow-up message uses cognitive mode with agents', async () => {
        console.log('\n=== Step 3: Follow-up task ===');
        // Now that agents are configured, a follow-up should use cognitive orchestration
        const response = await mainAgent.handleMessage('list my agents');
        console.log('Response:', response.text.slice(0, 500));
        // Should show the agents that were just configured
        expect(response.text).toBeTruthy();
    }, 60_000);
    it('Step 4: Dispatch a real task to an agent', async () => {
        console.log('\n=== Step 4: Dispatch real task ===');
        // Ask an agent to write the game's main file structure
        const response = await mainAgent.handleMessage('ask the implementer to describe the file structure for the snake game — just list the files and what each one does, nothing else');
        console.log('Response:', response.text.slice(0, 800));
        expect(response.text).toBeTruthy();
        expect(response.text.length).toBeGreaterThan(50);
    }, 120_000);
});
//# sourceMappingURL=full-stack-e2e.test.js.map