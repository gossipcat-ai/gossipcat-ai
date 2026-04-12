// tests/orchestrator/consensus-engine-verifier-tools.test.ts
//
// Tests for the verifierToolRunner tool loop in ConsensusEngine.crossReviewForAgent.
// MAX_VERIFIER_TURNS = 7 (defined in consensus-engine.ts)
//
// crossReviewForAgent is private — accessed via (engine as any).crossReviewForAgent().
// The method needs:
//   - agent: TaskEntry with agentId + status: 'completed'
//   - summaries: Map<string, string> with at least 2 agents
//   - engine config: { llm, registryGet, verifierToolRunner? }

import { ConsensusEngine, ConsensusEngineConfig } from '../../packages/orchestrator/src/consensus-engine';
import { TaskEntry, LLMResponse } from '../../packages/orchestrator/src/types';
import { ILLMProvider } from '../../packages/orchestrator/src/llm-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CROSS_REVIEW_JSON = JSON.stringify([
  {
    action: 'agree',
    findingId: 'peer-agent:f1',
    finding: 'Test finding',
    evidence: 'Confirmed in file.ts:10',
    confidence: 4,
  },
]);

/**
 * A valid agent_finding block so buildCrossReviewPrompt extracts at least one
 * peer finding. The reviewer agent (agent under test) cross-reviews this peer.
 */
const PEER_FINDING_BLOCK =
  '<agent_finding type="finding" severity="medium" title="Test finding">\n' +
  'Description (file.ts:10)\n' +
  '</agent_finding>';

function makeAgent(agentId: string): TaskEntry {
  return {
    id: `task-${agentId}`,
    agentId,
    task: 'review the code',
    status: 'completed',
    result: PEER_FINDING_BLOCK,
    startedAt: Date.now(),
    completedAt: Date.now(),
    inputTokens: 50,
    outputTokens: 100,
  };
}

/**
 * Summaries map: reviewer agent has no findings (empty string),
 * peer agent has findings. buildCrossReviewPrompt skips the reviewer's own
 * summary and parses the peer's findings for the cross-review prompt.
 */
function makeSummaries(reviewerId: string, peerId: string): Map<string, string> {
  return new Map([
    [reviewerId, ''],
    [peerId, PEER_FINDING_BLOCK],
  ]);
}

function makeMockRegistryGet() {
  return jest.fn((agentId: string) => ({
    id: agentId,
    agentId,
    provider: 'local' as const,
    model: 'test-model',
    preset: `preset-for-${agentId}`,
    skills: [],
  }));
}

// ---------------------------------------------------------------------------
// Test suite 1: text-only fallback (no verifierToolRunner)
// ---------------------------------------------------------------------------

describe('crossReviewForAgent — text-only fallback (no verifierToolRunner)', () => {
  let engine: ConsensusEngine;
  let mockLlm: jest.Mocked<ILLMProvider>;

  beforeEach(() => {
    mockLlm = { generate: jest.fn() };
    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: makeMockRegistryGet(),
    };
    engine = new ConsensusEngine(config);
  });

  it('calls llm.generate WITHOUT tools when verifierToolRunner is not set', async () => {
    mockLlm.generate.mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    await (engine as any).crossReviewForAgent(reviewer, summaries);

    expect(mockLlm.generate).toHaveBeenCalledTimes(1);
    // In the non-tool path, generate is called with options: { temperature: 0 }
    // and no `tools` key (or tools is absent/undefined)
    const [, options] = mockLlm.generate.mock.calls[0];
    expect(options).not.toHaveProperty('tools');
  });

  it('returns parsed cross-review entries from text response', async () => {
    mockLlm.generate.mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    const entries = await (engine as any).crossReviewForAgent(reviewer, summaries);

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].action).toBe('agree');
    expect(entries[0].peerAgentId).toBe('peer-agent');
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: tool loop basic
// ---------------------------------------------------------------------------

describe('crossReviewForAgent — tool loop basic', () => {
  let engine: ConsensusEngine;
  let mockLlm: jest.Mocked<ILLMProvider>;
  let verifierToolRunner: jest.Mock;

  beforeEach(() => {
    mockLlm = { generate: jest.fn() };
    verifierToolRunner = jest.fn();
    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: makeMockRegistryGet(),
      verifierToolRunner,
    };
    engine = new ConsensusEngine(config);
  });

  it('calls llm.generate WITH tools when verifierToolRunner is set', async () => {
    // First call returns a tool_use, second returns text
    const toolCallResponse: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: 'file.ts' } }],
    };
    const textResponse: LLMResponse = { text: VALID_CROSS_REVIEW_JSON };
    mockLlm.generate.mockResolvedValueOnce(toolCallResponse).mockResolvedValueOnce(textResponse);
    verifierToolRunner.mockResolvedValue('file contents here');

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    await (engine as any).crossReviewForAgent(reviewer, summaries);

    expect(mockLlm.generate).toHaveBeenCalledTimes(2);
    // First call must include `tools`
    const [, firstOptions] = mockLlm.generate.mock.calls[0];
    expect(firstOptions).toHaveProperty('tools');
    expect(Array.isArray(firstOptions!.tools)).toBe(true);
    expect(firstOptions!.tools!.length).toBeGreaterThan(0);
  });

  it('invokes verifierToolRunner callback with correct agentId, toolName, args', async () => {
    const toolCallResponse: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc1', name: 'file_read', arguments: { path: 'src/foo.ts', startLine: 1 } }],
    };
    mockLlm.generate
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });
    verifierToolRunner.mockResolvedValue('export function foo() {}');

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    await (engine as any).crossReviewForAgent(reviewer, summaries);

    expect(verifierToolRunner).toHaveBeenCalledWith(
      'reviewer-agent',
      'file_read',
      { path: 'src/foo.ts', startLine: 1 },
    );
  });

  it('appends tool result to messages and final text response is parsed', async () => {
    const toolCallResponse: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc1', name: 'file_grep', arguments: { pattern: 'foo', path: 'src/' } }],
    };
    mockLlm.generate
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });
    verifierToolRunner.mockResolvedValue('src/foo.ts:10: export function foo() {}');

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    const entries = await (engine as any).crossReviewForAgent(reviewer, summaries);

    // Second generate call receives messages including the tool result
    const secondCallMessages = mockLlm.generate.mock.calls[1][0];
    const toolResultMsg = secondCallMessages.find((m: any) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content).toBe('src/foo.ts:10: export function foo() {}');
    expect(toolResultMsg!.toolCallId).toBe('tc1');

    // Final entries parsed from VALID_CROSS_REVIEW_JSON
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].action).toBe('agree');
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: cap-hit recovery
// ---------------------------------------------------------------------------

describe('crossReviewForAgent — cap-hit recovery at MAX_VERIFIER_TURNS=7', () => {
  let engine: ConsensusEngine;
  let mockLlm: jest.Mocked<ILLMProvider>;
  let verifierToolRunner: jest.Mock;

  beforeEach(() => {
    mockLlm = { generate: jest.fn() };
    verifierToolRunner = jest.fn().mockResolvedValue('tool result');
    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: makeMockRegistryGet(),
      verifierToolRunner,
    };
    engine = new ConsensusEngine(config);
  });

  it('executes one more tool batch then makes a final text-only call after 7 tool turns', async () => {
    // Always return tool_use for the first 8 calls, then text for the 9th
    const alwaysToolCall: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc-cap', name: 'file_read', arguments: { path: 'file.ts' } }],
    };
    // Calls 1-8 return tool_use; call 9 is the final text-only call
    for (let i = 0; i < 8; i++) {
      mockLlm.generate.mockResolvedValueOnce(alwaysToolCall);
    }
    // The 9th generate call is the forced final text call (no tools in options)
    mockLlm.generate.mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    const entries = await (engine as any).crossReviewForAgent(reviewer, summaries);

    // Total generate calls: 7 normal tool-loop iterations + 1 cap iteration + 1 final = 9
    expect(mockLlm.generate).toHaveBeenCalledTimes(9);

    // The final (9th) generate call must NOT include tools — it's the "emit now" call
    const finalCallArgs = mockLlm.generate.mock.calls[8];
    const finalMessages = finalCallArgs[0];
    const finalOptions = finalCallArgs[1];
    expect(finalOptions).not.toHaveProperty('tools');

    // The "emit now" user message must be in the messages sent to the final call
    const emitNowMsg = finalMessages.find(
      (m: any) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('maximum verification turns'),
    );
    expect(emitNowMsg).toBeDefined();

    // Entries still parsed from the final text response
    expect(entries.length).toBeGreaterThan(0);
  });

  it('verifierToolRunner is called once more (cap batch) before the final emit-now call', async () => {
    const alwaysToolCall: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc-cap', name: 'file_read', arguments: { path: 'cap.ts' } }],
    };
    for (let i = 0; i < 8; i++) {
      mockLlm.generate.mockResolvedValueOnce(alwaysToolCall);
    }
    mockLlm.generate.mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    await (engine as any).crossReviewForAgent(reviewer, summaries);

    // 7 normal turns + 1 cap turn = 8 tool invocations total
    expect(verifierToolRunner).toHaveBeenCalledTimes(8);
  });
});

// ---------------------------------------------------------------------------
// Test suite 4: tool error handling
// ---------------------------------------------------------------------------

describe('crossReviewForAgent — tool error handling', () => {
  let engine: ConsensusEngine;
  let mockLlm: jest.Mocked<ILLMProvider>;
  let verifierToolRunner: jest.Mock;

  beforeEach(() => {
    mockLlm = { generate: jest.fn() };
    verifierToolRunner = jest.fn();
    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: makeMockRegistryGet(),
      verifierToolRunner,
    };
    engine = new ConsensusEngine(config);
  });

  it('catches verifierToolRunner errors and surfaces them as "Error: <message>" in tool result', async () => {
    const toolCallResponse: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc-err', name: 'file_read', arguments: { path: 'missing.ts' } }],
    };
    mockLlm.generate
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });

    verifierToolRunner.mockRejectedValue(new Error('file not found: missing.ts'));

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    // Should not throw — errors are caught and injected as tool results
    const entries = await (engine as any).crossReviewForAgent(reviewer, summaries);

    // The second generate call receives the error as a tool result
    const secondCallMessages = mockLlm.generate.mock.calls[1][0];
    const toolResultMsg = secondCallMessages.find((m: any) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content).toBe('Error: file not found: missing.ts');

    // Loop continues and eventually returns parsed entries
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('loop continues after error and final entries are returned', async () => {
    const toolCallResponse: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc-err2', name: 'file_grep', arguments: { pattern: 'boom' } }],
    };
    mockLlm.generate
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });

    verifierToolRunner.mockRejectedValue(new Error('grep exploded'));

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    const entries = await (engine as any).crossReviewForAgent(reviewer, summaries);

    expect(mockLlm.generate).toHaveBeenCalledTimes(2);
    expect(entries[0].action).toBe('agree');
    expect(entries[0].peerAgentId).toBe('peer-agent');
  });
});

// ---------------------------------------------------------------------------
// Test suite 5: output truncation
// ---------------------------------------------------------------------------

describe('crossReviewForAgent — tool output truncation', () => {
  let engine: ConsensusEngine;
  let mockLlm: jest.Mocked<ILLMProvider>;
  let verifierToolRunner: jest.Mock;

  beforeEach(() => {
    mockLlm = { generate: jest.fn() };
    verifierToolRunner = jest.fn();
    const config: ConsensusEngineConfig = {
      llm: mockLlm,
      registryGet: makeMockRegistryGet(),
      verifierToolRunner,
    };
    engine = new ConsensusEngine(config);
  });

  it('truncates tool output > 8000 chars with "…[truncated]" suffix', async () => {
    const bigOutput = 'x'.repeat(9000);
    const toolCallResponse: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc-big', name: 'file_read', arguments: { path: 'big.ts' } }],
    };
    mockLlm.generate
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });
    verifierToolRunner.mockResolvedValue(bigOutput);

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    await (engine as any).crossReviewForAgent(reviewer, summaries);

    const secondCallMessages = mockLlm.generate.mock.calls[1][0];
    const toolResultMsg = secondCallMessages.find((m: any) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content).toHaveLength(8000 + '\n…[truncated]'.length);
    expect(String(toolResultMsg!.content).endsWith('\n…[truncated]')).toBe(true);
  });

  it('does NOT truncate tool output of exactly 8000 chars', async () => {
    const exactOutput = 'y'.repeat(8000);
    const toolCallResponse: LLMResponse = {
      text: '',
      toolCalls: [{ id: 'tc-exact', name: 'file_read', arguments: { path: 'exact.ts' } }],
    };
    mockLlm.generate
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce({ text: VALID_CROSS_REVIEW_JSON });
    verifierToolRunner.mockResolvedValue(exactOutput);

    const reviewer = makeAgent('reviewer-agent');
    const summaries = makeSummaries('reviewer-agent', 'peer-agent');

    await (engine as any).crossReviewForAgent(reviewer, summaries);

    const secondCallMessages = mockLlm.generate.mock.calls[1][0];
    const toolResultMsg = secondCallMessages.find((m: any) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content).toBe(exactOutput);
    expect(toolResultMsg!.content).not.toContain('[truncated]');
  });
});
