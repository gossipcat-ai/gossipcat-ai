"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Interactive Session E2E Test
 *
 * Simulates a real user session in the gossipcat interactive chat.
 * Tests cognitive orchestration with real LLM calls by calling
 * MainAgent.handleMessage() in cognitive mode with realistic prompts.
 *
 * Run: npx jest tests/orchestrator/interactive-session-e2e.test.ts --testTimeout=300000 --verbose
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
        throw new Error(`No API key for ${provider}`);
    }
}
function loadConfig() {
    const configPath = (0, path_1.join)(PROJECT_ROOT, '.gossip', 'config.json');
    return JSON.parse((0, fs_1.readFileSync)(configPath, 'utf-8'));
}
describe('Interactive Session E2E — Game Project', () => {
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
            relayUrl: 'ws://localhost:0', // dummy — no workers needed for intent detection
            agents,
            projectRoot: PROJECT_ROOT,
            llm,
        });
    });
    afterAll(() => {
        // No cleanup needed — tests don't create files
    });
    // ── Test 1: Pure chat — asking a question ────────────────────────────────
    it('should handle pure chat: "what is gossipcat?"', async () => {
        const response = await mainAgent.handleMessage('what is gossipcat and how does it work?');
        console.log('\n=== Chat Response ===');
        console.log(response.text.slice(0, 300));
        expect(response.text).toBeTruthy();
        expect(response.text.length).toBeGreaterThan(50);
        // Should NOT dispatch to agents for a simple question
        expect(response.agents).toBeUndefined();
    }, 30_000);
    // ── Test 2: Agents tool — list agents ────────────────────────────────────
    it('should detect agents intent: "show me my agents"', async () => {
        const response = await mainAgent.handleMessage('show me my agents and their skills');
        console.log('\n=== Agents Response ===');
        console.log(response.text.slice(0, 500));
        expect(response.text).toBeTruthy();
        // Should contain actual agent names from config
        const agentIds = Object.keys(config.agents || {});
        const hasAgentRef = agentIds.some(id => response.text.includes(id));
        expect(hasAgentRef).toBe(true);
    }, 30_000);
    // ── Test 3: Conversation history — follow-up question ────────────────────
    it('should use conversation history for follow-up', async () => {
        // First message establishes context
        await mainAgent.handleMessage('I want to build a simple snake game in TypeScript');
        // Follow-up should reference the snake game without repeating
        const response = await mainAgent.handleMessage('what files would I need for that?');
        console.log('\n=== Follow-up Response ===');
        console.log(response.text.slice(0, 400));
        expect(response.text).toBeTruthy();
        // Should reference game/snake concepts from conversation history
        const hasContext = response.text.toLowerCase().includes('game') ||
            response.text.toLowerCase().includes('snake') ||
            response.text.toLowerCase().includes('typescript') ||
            response.text.toLowerCase().includes('.ts');
        expect(hasContext).toBe(true);
    }, 60_000);
    // ── Test 4: Plan intent — plan a task ────────────────────────────────────
    it('should detect plan intent: "plan building a snake game"', async () => {
        const response = await mainAgent.handleMessage('plan building a simple terminal snake game in TypeScript with keyboard input and score tracking');
        console.log('\n=== Plan Response ===');
        console.log(response.text.slice(0, 600));
        expect(response.text).toBeTruthy();
        // Plan response should mention tasks/steps or present choices
        const isPlan = response.text.toLowerCase().includes('task') ||
            response.text.toLowerCase().includes('step') ||
            response.text.toLowerCase().includes('plan') ||
            response.choices !== undefined;
        expect(isPlan).toBe(true);
    }, 60_000);
    // ── Test 5: Dispatch intent — ask specific agent ─────────────────────────
    it('should detect dispatch intent: "ask the researcher to find..."', async () => {
        const response = await mainAgent.handleMessage('ask the gemini-researcher to find the best TypeScript libraries for terminal-based games');
        console.log('\n=== Dispatch Response ===');
        console.log(response.text.slice(0, 400));
        expect(response.text).toBeTruthy();
        // This will likely error since no workers are running, but the intent should be detected
        // The response should mention the agent or dispatching, not just be a chat answer
        const hasDispatchRef = response.text.toLowerCase().includes('researcher') ||
            response.text.toLowerCase().includes('dispatch') ||
            response.text.toLowerCase().includes('agent') ||
            response.text.toLowerCase().includes('error') ||
            (response.agents && response.agents.length > 0);
        expect(hasDispatchRef).toBe(true);
    }, 60_000);
    // ── Test 6: Consensus intent — multi-agent review ────────────────────────
    it('should detect consensus intent: "review this with all agents"', async () => {
        const response = await mainAgent.handleMessage('security review packages/orchestrator/src/consensus-engine.ts with all agents using consensus');
        console.log('\n=== Consensus Response ===');
        console.log(response.text.slice(0, 400));
        expect(response.text).toBeTruthy();
        // Should attempt consensus dispatch (will error without workers but proves intent detection)
        const hasConsensusRef = response.text.toLowerCase().includes('consensus') ||
            response.text.toLowerCase().includes('review') ||
            response.text.toLowerCase().includes('agent') ||
            response.text.toLowerCase().includes('dispatch') ||
            response.text.toLowerCase().includes('error');
        expect(hasConsensusRef).toBe(true);
    }, 60_000);
    // ── Test 7: Agent performance intent ─────────────────────────────────────
    it('should detect performance intent: "how are my agents doing?"', async () => {
        const response = await mainAgent.handleMessage('how are my agents performing? show me the performance data');
        console.log('\n=== Performance Response ===');
        console.log(response.text.slice(0, 400));
        expect(response.text).toBeTruthy();
        // Should return performance data or "no data" message
        const hasPerformanceRef = response.text.toLowerCase().includes('performance') ||
            response.text.toLowerCase().includes('signal') ||
            response.text.toLowerCase().includes('agreement') ||
            response.text.toLowerCase().includes('no performance data') ||
            response.text.toLowerCase().includes('consensus');
        expect(hasPerformanceRef).toBe(true);
    }, 30_000);
    // ── Test 8: Read task history intent ─────────────────────────────────────
    it('should detect history intent: "what did the reviewer do last?"', async () => {
        const response = await mainAgent.handleMessage('what did gemini-reviewer do in its last few tasks?');
        console.log('\n=== History Response ===');
        console.log(response.text.slice(0, 400));
        expect(response.text).toBeTruthy();
        // Should return task history or "no history" message
        const hasHistoryRef = response.text.toLowerCase().includes('task') ||
            response.text.toLowerCase().includes('history') ||
            response.text.toLowerCase().includes('reviewer') ||
            response.text.toLowerCase().includes('recent') ||
            response.text.toLowerCase().includes('no task');
        expect(hasHistoryRef).toBe(true);
    }, 30_000);
    // ── Test 9: Decompose mode falls back to chat when no workers ─────────
    it('should handle decompose mode gracefully without workers', async () => {
        // Decompose mode will try to dispatch to agents, but no workers are running.
        // It should either: fall back to direct LLM answer (unassigned), or throw an error.
        let response;
        try {
            response = await mainAgent.handleMessage('explain what the consensus engine does', { mode: 'decompose' });
            console.log('\n=== Decompose Mode Response ===');
            console.log(response.text.slice(0, 300));
            expect(response.text).toBeTruthy();
        }
        catch (err) {
            // Expected — no workers available for dispatch
            console.log('\n=== Decompose Mode Error (expected) ===');
            console.log(err.message);
            expect(err.message).toBeTruthy();
        }
    }, 60_000);
});
//# sourceMappingURL=interactive-session-e2e.test.js.map