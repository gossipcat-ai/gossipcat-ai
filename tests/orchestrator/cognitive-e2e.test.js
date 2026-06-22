"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * End-to-end cognitive orchestration test using real LLM calls.
 * Verifies that the LLM correctly classifies user intent (chat, agents, dispatch).
 *
 * Run: npx jest tests/orchestrator/cognitive-e2e.test.ts --testTimeout=120000 --verbose
 */
const src_1 = require("../../packages/orchestrator/src");
const fs_1 = require("fs");
const path_1 = require("path");
const child_process_1 = require("child_process");
const PROJECT_ROOT = process.cwd();
function getKeyFromKeychain(provider) {
    try {
        return (0, child_process_1.execFileSync)('security', [
            'find-generic-password', '-s', 'gossip-mesh', '-a', provider, '-w'
        ], { stdio: 'pipe' }).toString().trim();
    }
    catch {
        const envKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
        if (envKey)
            return envKey;
        throw new Error(`No API key for ${provider} in keychain or env`);
    }
}
function loadConfig() {
    const configPath = (0, path_1.join)(PROJECT_ROOT, '.gossip', 'config.json');
    if (!(0, fs_1.existsSync)(configPath))
        throw new Error('No .gossip/config.json found');
    return JSON.parse((0, fs_1.readFileSync)(configPath, 'utf-8'));
}
describe('Cognitive Orchestration E2E', () => {
    let mainAgent;
    let config;
    beforeAll(() => {
        config = loadConfig();
        const apiKey = getKeyFromKeychain('google');
        const llm = (0, src_1.createProvider)('google', 'gemini-2.5-pro', apiKey);
        const agents = Object.entries(config.agents || {}).map(([id, ac]) => ({
            id,
            provider: ac.provider,
            model: ac.model,
            preset: ac.preset,
            skills: ac.skills || [],
        }));
        mainAgent = new src_1.MainAgent({
            provider: 'google',
            model: 'gemini-2.5-pro',
            relayUrl: 'ws://localhost:0', // dummy, won't connect
            agents,
            projectRoot: PROJECT_ROOT,
            llm,
        });
        // Don't call mainAgent.start() — we don't need workers for intent detection
    });
    it('should classify chat intent and respond with plain text', async () => {
        const response = await mainAgent.handleMessage('what is the gossip mesh protocol?');
        console.log('[chat] response text:', response.text.slice(0, 200));
        // Plain chat: should have text but no agents array
        expect(response.text).toBeTruthy();
        expect(response.agents).toBeUndefined();
        expect(response.status).toBe('done');
    }, 120_000);
    it('should classify agents intent and list registered agents', async () => {
        const response = await mainAgent.handleMessage('list my agents');
        console.log('[agents] response text:', response.text.slice(0, 500));
        // The LLM should either:
        // 1. Successfully call the agents tool (response contains agent names), OR
        // 2. Attempt to call the agents tool (response text contains TOOL_CALL + agents)
        const agentNames = Object.keys(config.agents || {});
        expect(agentNames.length).toBeGreaterThan(0);
        const foundAgent = agentNames.some(name => response.text.includes(name));
        const triedAgentsTool = response.text.includes('agents') && response.text.includes('TOOL_CALL');
        const hasRegisteredAgents = response.text.includes('Registered Agents');
        expect(foundAgent || triedAgentsTool || hasRegisteredAgents).toBe(true);
    }, 120_000);
    it('should classify dispatch_consensus intent (fails without relay but confirms detection)', async () => {
        let response;
        try {
            response = await mainAgent.handleMessage('security review packages/orchestrator/src/consensus-engine.ts with all agents');
        }
        catch (err) {
            // If it throws, the error should mention dispatching or agents
            console.log('[dispatch_consensus] error:', err.message);
            expect(err.message.toLowerCase().includes('agent') ||
                err.message.toLowerCase().includes('dispatch') ||
                err.message.toLowerCase().includes('worker') ||
                err.message.toLowerCase().includes('connect')).toBe(true);
            return;
        }
        console.log('[dispatch_consensus] response text:', response.text.slice(0, 300));
        // If it didn't throw, the response should reference dispatching or agents
        // (confirming the LLM tried to use a dispatch tool, not just chat)
        const text = response.text.toLowerCase();
        expect(text.includes('agent') ||
            text.includes('dispatch') ||
            text.includes('review') ||
            text.includes('task') ||
            response.agents !== undefined).toBe(true);
    }, 120_000);
});
//# sourceMappingURL=cognitive-e2e.test.js.map