"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const consensus_engine_1 = require("../../packages/orchestrator/src/consensus-engine");
/**
 * Creates a pair of findings that will force the Tier-3 word overlap logic.
 * They share just enough significant words to pass the 0.5 threshold but are
 * not substrings of each other.
 */
const createTier3FindingPair = (id) => {
    const baseWords = ['system', 'performance', 'bottleneck', 'optimization', 'database', 'query'];
    const originalWords = [...baseWords, 'alpha', 'bravo', 'charlie', `id${id}`];
    const fuzzyWords = [...baseWords, 'delta', 'echo', 'foxtrot', `id${id}`];
    // This structure ensures they are not substrings of one another.
    const original = `Initial review of ${originalWords.join(' ')} suggests a critical issue.`;
    const fuzzy = `A critical issue is suggested by our secondary review of ${fuzzyWords.join(' ')}.`;
    return [original, fuzzy];
};
describe('ConsensusEngine DoS', () => {
    let engine;
    let mockLlm;
    beforeEach(() => {
        mockLlm = { generate: jest.fn() };
        engine = new consensus_engine_1.ConsensusEngine({
            llm: mockLlm,
            registryGet: (agentId) => ({
                id: agentId, provider: 'local', model: 'test-model', skills: [], preset: 'test-preset'
            }),
        });
    });
    it('should exhibit O(N*M) complexity when findings consistently force Tier-3 matching', () => {
        // These numbers are carefully chosen to be high enough to cause a noticeable delay
        // but not so high that the test times out instantly.
        const numAgents = 4;
        const findingsPerAgent = 25; // Total original findings: 4 * 25 = 100
        const disagreeingAgents = 4;
        const disputedFindings = 25; // Total cross-review entries: 4 * 3 * 25 = 300
        const results = [];
        const findingMap = new Map();
        // Arrange: Generate initial findings that are designed to be "heavy"
        for (let i = 0; i < numAgents; i++) {
            const agentId = `agent-${i}`;
            let result = '## Consensus Summary\n';
            for (let j = 0; j < findingsPerAgent; j++) {
                const findingId = `${i}-${j}`;
                const [original, fuzzy] = createTier3FindingPair(j);
                findingMap.set(findingId, { original, fuzzy });
                result += `- ${original}\n`;
            }
            results.push({
                id: `task-${i}`, agentId, task: 'review code', status: 'completed', result,
                startedAt: Date.now() - 1000, completedAt: Date.now(),
            });
        }
        // Arrange: Generate cross-review entries that use the "fuzzy" pair to force Tier-3
        const crossReviewEntries = [];
        for (let i = 0; i < disagreeingAgents; i++) {
            const reviewerId = `agent-${i}`;
            for (let j = 0; j < numAgents; j++) {
                const peerId = `agent-${j}`;
                if (reviewerId === peerId)
                    continue;
                for (let k = 0; k < disputedFindings; k++) {
                    const findingId = `${j}-${k}`;
                    const { fuzzy } = findingMap.get(findingId);
                    crossReviewEntries.push({
                        action: 'disagree', agentId: reviewerId, peerAgentId: peerId,
                        finding: fuzzy, // Use the fuzzy version
                        evidence: 'Evidence points to a different conclusion.', confidence: 3,
                    });
                }
            }
        }
        // Act: Measure the synthesis duration
        const startTime = Date.now();
        engine.synthesize(results, crossReviewEntries);
        const duration = Date.now() - startTime;
        console.log(`DoS test with optimized Tier-3 trigger duration: ${duration}ms`);
        // Assert: The duration should be significantly long, confirming the performance issue.
        // This threshold is set based on expected performance for this volume of data.
        // If it's much faster, the vulnerability isn't being triggered correctly.
        expect(duration).toBeGreaterThan(1500);
    }, 10000); // 10-second timeout for the test itself.
});
//# sourceMappingURL=consensus-engine.dos.test.js.map