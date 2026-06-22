"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("@gossip/orchestrator");
function mockWorker(result = 'found 3 bugs in tool-server.ts') {
    return {
        executeTask: jest.fn().mockResolvedValue({ result, inputTokens: 0, outputTokens: 0 }),
        subscribeToBatch: jest.fn().mockResolvedValue(undefined),
        unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
    };
}
function mockLLM(summary = 'Found 3 bugs in tool-server.ts') {
    return { generate: jest.fn().mockResolvedValue({ text: summary }) };
}
describe('Session Gossip', () => {
    it('injects prior task summary into next dispatch prompt', async () => {
        const workers = new Map([['agent-a', mockWorker()], ['agent-b', mockWorker()]]);
        const llm = mockLLM();
        const pipeline = new orchestrator_1.DispatchPipeline({
            projectRoot: '/tmp/gossip-test-' + Date.now(),
            workers,
            registryGet: (id) => ({ id, provider: 'google', model: 'mock', skills: [] }),
            llm,
        });
        const t1 = pipeline.dispatch('agent-a', 'review code');
        await pipeline.collect([t1.taskId]);
        await new Promise(r => setImmediate(r)); // let fire-and-forget gossip settle
        pipeline.dispatch('agent-b', 'fix bugs');
        const worker = workers.get('agent-b');
        const prompt = worker.executeTask.mock.calls[0][2];
        expect(prompt).toContain('Session Context');
        expect(prompt).toContain('agent-a');
    });
    it('caps session gossip at 20 entries', async () => {
        const workers = new Map([['agent', mockWorker()]]);
        const llm = mockLLM();
        const pipeline = new orchestrator_1.DispatchPipeline({
            projectRoot: '/tmp/gossip-test-' + Date.now(),
            workers,
            registryGet: (id) => ({ id, provider: 'google', model: 'mock', skills: [] }),
            llm,
        });
        for (let i = 0; i < 25; i++) {
            const t = pipeline.dispatch('agent', `task ${i}`);
            await pipeline.collect([t.taskId]);
            await new Promise(r => setImmediate(r));
        }
        pipeline.dispatch('agent', 'final task');
        const prompt = workers.get('agent').executeTask.mock.calls[25][2];
        const matches = (prompt || '').match(/- agent:/g) || [];
        expect(matches.length).toBeLessThanOrEqual(20);
    });
    it('skips summarization when no LLM provided', async () => {
        const workers = new Map([['agent', mockWorker()]]);
        const pipeline = new orchestrator_1.DispatchPipeline({
            projectRoot: '/tmp/gossip-test-' + Date.now(),
            workers,
            registryGet: (id) => ({ id, provider: 'google', model: 'mock', skills: [] }),
        });
        const t1 = pipeline.dispatch('agent', 'task 1');
        await pipeline.collect([t1.taskId]);
        pipeline.dispatch('agent', 'task 2');
        const prompt = workers.get('agent').executeTask.mock.calls[1][2] || '';
        expect(prompt).not.toContain('Session Context');
    });
});
describe('Chain Threading', () => {
    it('injects prior step result as chain context', async () => {
        const workers = new Map([['agent-a', mockWorker('step 1 found the bug')], ['agent-b', mockWorker()]]);
        const pipeline = new orchestrator_1.DispatchPipeline({
            projectRoot: '/tmp/gossip-test-' + Date.now(),
            workers,
            registryGet: (id) => ({ id, provider: 'google', model: 'mock', skills: [] }),
        });
        pipeline.registerPlan({
            id: 'plan-1',
            task: 'fix bug',
            strategy: 'sequential',
            steps: [
                { step: 1, agentId: 'agent-a', task: 'investigate' },
                { step: 2, agentId: 'agent-b', task: 'fix it' },
            ],
            createdAt: Date.now(),
        });
        const t1 = pipeline.dispatch('agent-a', 'investigate', { planId: 'plan-1', step: 1 });
        await pipeline.collect([t1.taskId]);
        pipeline.dispatch('agent-b', 'fix it', { planId: 'plan-1', step: 2 });
        const prompt = workers.get('agent-b').executeTask.mock.calls[0][2];
        expect(prompt).toContain('Chain Context');
        expect(prompt).toContain('step 1 found the bug');
    });
    it('gracefully handles missing plan_id', () => {
        const workers = new Map([['agent', mockWorker()]]);
        const pipeline = new orchestrator_1.DispatchPipeline({
            projectRoot: '/tmp/gossip-test-' + Date.now(),
            workers,
            registryGet: (id) => ({ id, provider: 'google', model: 'mock', skills: [] }),
        });
        expect(() => pipeline.dispatch('agent', 'task', { planId: 'nonexistent', step: 2 })).not.toThrow();
    });
    it('cleans up completed plans', async () => {
        const workers = new Map([['agent', mockWorker()]]);
        const pipeline = new orchestrator_1.DispatchPipeline({
            projectRoot: '/tmp/gossip-test-' + Date.now(),
            workers,
            registryGet: (id) => ({ id, provider: 'google', model: 'mock', skills: [] }),
        });
        pipeline.registerPlan({
            id: 'plan-done',
            task: 'one step',
            strategy: 'single',
            steps: [{ step: 1, agentId: 'agent', task: 'do it' }],
            createdAt: Date.now(),
        });
        const t = pipeline.dispatch('agent', 'do it', { planId: 'plan-done', step: 1 });
        await pipeline.collect([t.taskId]);
        pipeline.dispatch('agent', 'next', { planId: 'plan-done', step: 2 });
        const prompt = workers.get('agent').executeTask.mock.calls[1][2] || '';
        expect(prompt).not.toContain('Chain Context');
    });
});
//# sourceMappingURL=dispatch-pipeline-gossip.test.js.map