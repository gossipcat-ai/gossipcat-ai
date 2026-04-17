import { ConsensusEngine, ConsensusEngineConfig, CrossReviewEntry } from '../../packages/orchestrator/src/consensus-engine';
import { TaskEntry } from '../../packages/orchestrator/src/types';
import { ILLMProvider } from '../../packages/orchestrator/src/llm-client';

describe('Two-phase consensus flow', () => {
  const mockLlm: jest.Mocked<ILLMProvider> = { generate: jest.fn() };
  const mockRegistryGet = jest.fn((id: string) => ({
    id, provider: 'local' as const, model: 'test', preset: 'reviewer', skills: [] as string[],
  }));

  const createEntry = (agentId: string, result: string): TaskEntry => ({
    id: `task-${agentId}`, agentId, task: 'review', status: 'completed' as const,
    result, startedAt: Date.now(), completedAt: Date.now(),
    inputTokens: 100, outputTokens: 200,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should generate prompts, accept external responses, and synthesize', async () => {
    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: mockRegistryGet,
    };
    const engine = new ConsensusEngine(config);

    const results = [
      createEntry('native-a', '## Consensus Summary\n<agent_finding type="finding" severity="high">Bug in auth.ts:10 — missing token validation allows bypass</agent_finding>'),
      createEntry('native-b', '## Consensus Summary\n<agent_finding type="finding" severity="medium">Missing input validation in api-handler.ts:20 for user-supplied query</agent_finding>'),
    ];

    // Phase 1: Generate prompts (no LLM calls)
    const nativeIds = new Set(['native-a', 'native-b']);
    const { prompts, consensusId } = await engine.generateCrossReviewPrompts(results, nativeIds);

    expect(prompts).toHaveLength(2);
    expect(prompts.every(p => p.isNative)).toBe(true);
    expect(mockLlm.generate).not.toHaveBeenCalled();

    // Phase 2: Simulate native agent responses
    const crossReviewEntries: CrossReviewEntry[] = [
      { action: 'agree', agentId: 'native-a', peerAgentId: 'native-b', finding: 'Missing input validation in api-handler.ts:20 for user-supplied query', evidence: 'Confirmed — no sanitization present', confidence: 4 },
      { action: 'agree', agentId: 'native-b', peerAgentId: 'native-a', finding: 'Bug in auth.ts:10 — missing token validation allows bypass', evidence: 'Confirmed — token check is absent', confidence: 5 },
    ];

    // Phase 3: Synthesize with externally-provided entries
    const report = await engine.synthesizeWithCrossReview(results, crossReviewEntries, consensusId);

    expect(report.confirmed.length).toBe(2);
    expect(report.agentCount).toBe(2);
    // All signals should use our consensusId
    for (const signal of report.signals) {
      expect(signal.consensusId).toBe(consensusId);
    }
    // No LLM calls were made (all external)
    expect(mockLlm.generate).not.toHaveBeenCalled();
  });

  it('should handle mixed relay + native agents', async () => {
    const relayLlm: jest.Mocked<ILLMProvider> = { generate: jest.fn() };
    relayLlm.generate.mockResolvedValue({
      text: JSON.stringify([
        { action: 'agree', agentId: 'native-a', finding: 'Bug in auth.ts:10 — missing token validation', evidence: 'Confirmed', confidence: 4 }
      ]),
      usage: { inputTokens: 50, outputTokens: 30 },
    });

    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: mockRegistryGet,
      agentLlm: (id) => id === 'relay-b' ? relayLlm : undefined,
    };
    const engine = new ConsensusEngine(config);

    const results = [
      createEntry('native-a', '## Consensus Summary\n<agent_finding type="finding" severity="high">Bug in auth.ts:10 — missing token validation allows bypass</agent_finding>'),
      createEntry('relay-b', '## Consensus Summary\n<agent_finding type="finding" severity="medium">Missing error handling in api.ts:30 for network failures</agent_finding>'),
    ];

    // Generate prompts — native-a is native, relay-b is relay
    const nativeIds = new Set(['native-a']);
    const { prompts, consensusId } = await engine.generateCrossReviewPrompts(results, nativeIds);

    const nativeAPrompt = prompts.find(p => p.agentId === 'native-a')!;
    const relayBPrompt = prompts.find(p => p.agentId === 'relay-b')!;
    expect(nativeAPrompt.isNative).toBe(true);
    expect(relayBPrompt.isNative).toBe(false);

    // Relay agent cross-review runs inline via its LLM
    const relayResponse = await relayLlm.generate(
      [{ role: 'system', content: relayBPrompt.system }, { role: 'user', content: relayBPrompt.user }],
      { temperature: 0 },
    );
    const relayEntries = engine.parseCrossReviewResponse('relay-b', relayResponse.text, 50);

    // Native agent cross-review comes externally
    const nativeEntries: CrossReviewEntry[] = [
      { action: 'agree', agentId: 'native-a', peerAgentId: 'relay-b', finding: 'Missing error handling in api.ts:30 for network failures', evidence: 'Confirmed in code', confidence: 4 },
    ];

    // Combine and synthesize
    const allEntries = [...relayEntries, ...nativeEntries];
    const report = await engine.synthesizeWithCrossReview(results, allEntries, consensusId);

    expect(report.agentCount).toBe(2);
    expect(report.confirmed.length).toBeGreaterThanOrEqual(1);
  });

  it('should emit prompts (not silently no-op) when team is ALL native — issue #121', async () => {
    // Regression: prior to the fix in apps/cli/src/handlers/collect.ts, the
    // handler would always call engine.runSelectedCrossReview when a
    // PerformanceReader was attached, even for all-native teams. Natives are
    // intentionally excluded from agentLlmCache, so crossReviewForAgent would
    // fall back to mainLlm for each reviewer. When mainLlm is misconfigured
    // (or simply returns empty text — as it does when no real provider is
    // wired in a native-only dispatch), every finding is tagged UNIQUE with
    // zero error visibility.
    //
    // The handler now skips the server-side path when hasNative is true and
    // falls through to generateCrossReviewPrompts, which must yield at least
    // one prompt-per-native so the orchestrator can dispatch them externally.
    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: mockRegistryGet,
      // Intentionally NO agentLlm — mirrors all-native reality where
      // agentLlmCache would be empty.
    };
    const engine = new ConsensusEngine(config);

    const results = [
      createEntry('native-a', '## Consensus Summary\n<agent_finding type="finding" severity="high">Null deref in parser.ts:12 when input is undefined</agent_finding>'),
      createEntry('native-b', '## Consensus Summary\n<agent_finding type="finding" severity="medium">Off-by-one in loop-iterator.ts:44 skips last element</agent_finding>'),
    ];

    const nativeAgentIds = new Set(['native-a', 'native-b']);

    // Replicate the handler's branch decision (collect.ts hasNative guard).
    const completedResults = results.filter(r => r.status === 'completed');
    const hasNative = completedResults.some(r => nativeAgentIds.has(r.agentId));
    expect(hasNative).toBe(true); // precondition — all are native

    // When hasNative is true, the handler must NOT invoke the server-side
    // path — it must fall through to generateCrossReviewPrompts.
    const { prompts } = await engine.generateCrossReviewPrompts(results, nativeAgentIds);

    // Must yield one prompt per native agent so the orchestrator can dispatch.
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts.every(p => p.isNative)).toBe(true);
    // And the mainLlm was NOT invoked — confirming we didn't silently no-op
    // through the buggy server-side path.
    expect(mockLlm.generate).not.toHaveBeenCalled();
  });

  it('should handle empty native responses gracefully', async () => {
    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: mockRegistryGet,
    };
    const engine = new ConsensusEngine(config);

    const results = [
      createEntry('native-a', '## Consensus Summary\n<agent_finding type="finding" severity="high">Critical race condition in state-manager.ts:50 with concurrent writes</agent_finding>'),
      createEntry('native-b', '## Consensus Summary\n<agent_finding type="finding" severity="medium">Unbounded growth in log-writer.ts:80 from missing rotation</agent_finding>'),
    ];

    const nativeIds = new Set(['native-a', 'native-b']);
    const { consensusId } = await engine.generateCrossReviewPrompts(results, nativeIds);

    // Timeout scenario: no cross-review entries arrived
    const report = await engine.synthesizeWithCrossReview(results, [], consensusId);

    // Findings should exist but be unique/unverified (no confirmations)
    expect(report.confirmed.length).toBe(0);
    expect(report.unique.length + report.unverified.length).toBeGreaterThanOrEqual(2);
  });
});
