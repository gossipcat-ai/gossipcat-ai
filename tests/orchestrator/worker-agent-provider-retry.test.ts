// @gossip:impact-adjacent:signal-pipeline
/**
 * Tests for the provider-placeholder retry logic introduced in
 * packages/orchestrator/src/worker-agent.ts (spec: 2026-05-17-gemini-malformed-retry.md).
 *
 * Covers:
 *  (a) retry succeeds — placeholder turn 3 → real response on retry → loop continues
 *  (b) retry also fails — placeholder twice → exits with placeholder text
 *  (c) one retry per dispatch — placeholder turn 2 (retry succeeds → turn 3 normal)
 *      → placeholder turn 5 → no second retry, exits immediately
 *  (d) signal-emission — placeholder dispatch emits transport_failure, NOT format_compliance:0
 */

import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PROVIDER_PLACEHOLDER_RE, emitCompletionSignals } from '@gossip/orchestrator';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_MALFORMED = '[No response from Gemini: malformed_function_call finishReason=MALFORMED_FUNCTION_CALL]';
const PLACEHOLDER_SAFETY = '[Response blocked by Gemini safety filter]';
const REAL_RESPONSE_TEXT = 'Task complete. <agent_finding type="finding" severity="low">No issues found.<cite tag="file">src/foo.ts:1</cite></agent_finding>';

interface LLMResponse {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

interface LLMProvider {
  generate: (messages: unknown[]) => Promise<LLMResponse>;
}

/**
 * Simulate the worker-agent retry loop logic in isolation, mirroring the
 * production code in worker-agent.ts executeTask. Extracted as a standalone
 * function so we can test it without spinning up GossipAgent / relay sockets.
 *
 * Mirrors the production code structure faithfully — any drift between this
 * simulator and the real loop is a test quality risk.
 */
async function simulateRetryLoop(
  llm: LLMProvider,
  maxTurns = 10,
): Promise<{ result: string; logLines: string[]; retryAttempted: boolean }> {
  const messages: unknown[] = [{ role: 'user', content: 'Do work' }];
  const logLines: string[] = [];
  let providerRetryAttempted = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    let response = await llm.generate(messages);
    logLines.push(`turn ${turn}: text=${response.text?.slice(0, 80) ?? 'none'} toolCalls=${response.toolCalls?.length ?? 0}`);

    // @gossip:impact-adjacent:signal-pipeline
    // Mirror of worker-agent.ts placeholder-detection + retry
    if (
      !response.toolCalls?.length &&
      response.text &&
      PROVIDER_PLACEHOLDER_RE.test(response.text) &&
      !providerRetryAttempted
    ) {
      providerRetryAttempted = true;
      logLines.push(`turn ${turn} — provider placeholder detected, retrying once: "${response.text.slice(0, 80)}"`);
      response = await llm.generate(messages);
      logLines.push(`turn ${turn} — retry returned: text=${response.text?.length ?? 0}chars, toolCalls=${response.toolCalls?.length ?? 0}`);
      // If retry still placeholder, fall through to existing "no tool calls" exit
    }

    if (!response.toolCalls?.length) {
      logLines.push(`turn ${turn} — NO tool calls, exiting`);
      return { result: response.text ?? '[No response]', logLines, retryAttempted: providerRetryAttempted };
    }

    // Push assistant + tool results for the next turn
    messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: response.toolCalls });
    for (const tc of response.toolCalls!) {
      messages.push({ role: 'tool', content: 'tool result', toolCallId: tc.id, name: tc.name });
    }
  }

  return { result: 'Max turns reached', logLines, retryAttempted: providerRetryAttempted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests (a) – (c): retry-loop behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('worker-agent provider placeholder retry', () => {
  // (a) Retry succeeds: placeholder on turn 3, retry returns real toolCalls → loop continues
  it('(a) retry succeeds: placeholder → real response with toolCalls → loop continues', async () => {
    let callCount = 0;
    const llm: LLMProvider = {
      async generate() {
        callCount++;
        // Turns 1–2: normal tool calls
        if (callCount <= 2) {
          return { text: `Turn ${callCount}`, toolCalls: [{ id: `c${callCount}`, name: 'noop', arguments: {} }] };
        }
        // Turn 3 (callCount=3): placeholder
        if (callCount === 3) {
          return { text: PLACEHOLDER_MALFORMED, toolCalls: [] };
        }
        // Turn 3 RETRY (callCount=4): real toolCalls → loop continues
        if (callCount === 4) {
          return { text: 'Recovered', toolCalls: [{ id: 'c4', name: 'noop', arguments: {} }] };
        }
        // Turn 4 (callCount=5): done
        return { text: REAL_RESPONSE_TEXT };
      },
    };

    const { result, logLines, retryAttempted } = await simulateRetryLoop(llm, 10);

    expect(retryAttempted).toBe(true);
    // The loop continued past the retry and got a real final result
    expect(result).toBe(REAL_RESPONSE_TEXT);
    // 5 calls total: turns 1, 2, 3 (placeholder), 3-retry, 4 (done)
    expect(callCount).toBe(5);
    // Log must record the retry
    expect(logLines.some(l => l.includes('provider placeholder detected, retrying once'))).toBe(true);
    expect(logLines.some(l => l.includes('retry returned'))).toBe(true);
  });

  // (b) Retry also fails: placeholder twice → exit with placeholder text
  it('(b) retry also fails: placeholder returned twice → exits with placeholder diagnostic', async () => {
    let callCount = 0;
    const llm: LLMProvider = {
      async generate() {
        callCount++;
        // First call: returns placeholder
        if (callCount === 1) {
          return { text: PLACEHOLDER_MALFORMED };
        }
        // Retry (callCount=2): also placeholder
        return { text: PLACEHOLDER_SAFETY };
      },
    };

    const { result, logLines, retryAttempted } = await simulateRetryLoop(llm, 10);

    expect(retryAttempted).toBe(true);
    // Loop exits with the placeholder text from the retry — diagnostic is visible
    expect(result).toBe(PLACEHOLDER_SAFETY);
    expect(callCount).toBe(2);
    // First attempt must be logged
    expect(logLines.some(l => l.includes('provider placeholder detected, retrying once'))).toBe(true);
    // Exit must be logged
    expect(logLines.some(l => l.includes('NO tool calls, exiting'))).toBe(true);
  });

  // (c) One retry per dispatch: placeholder turn 2 (retry succeeds) → placeholder turn 5 → NO retry
  it('(c) one retry per dispatch: second placeholder does not trigger another retry', async () => {
    let callCount = 0;
    const llm: LLMProvider = {
      async generate() {
        callCount++;
        // Turn 1: normal tool call
        if (callCount === 1) {
          return { text: 'Turn 1', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }] };
        }
        // Turn 2 (callCount=2): placeholder
        if (callCount === 2) {
          return { text: PLACEHOLDER_MALFORMED };
        }
        // Turn 2 RETRY (callCount=3): real response → loop continues
        if (callCount === 3) {
          return { text: 'Turn 2 recovered', toolCalls: [{ id: 'c3', name: 'noop', arguments: {} }] };
        }
        // Turn 3 (callCount=4): another tool call
        if (callCount === 4) {
          return { text: 'Turn 3', toolCalls: [{ id: 'c4', name: 'noop', arguments: {} }] };
        }
        // Turn 4 (callCount=5): second placeholder — providerRetryAttempted is already true
        // → NO retry, falls through to "NO tool calls" exit immediately
        return { text: PLACEHOLDER_MALFORMED };
      },
    };

    const { result, logLines, retryAttempted } = await simulateRetryLoop(llm, 10);

    expect(retryAttempted).toBe(true);
    // Only one retry was attempted (callCount stops at 5, not 6)
    expect(callCount).toBe(5);
    // Second placeholder exits immediately — diagnostic text preserved
    expect(result).toBe(PLACEHOLDER_MALFORMED);
    // Exactly one "retrying once" log line
    const retryLogs = logLines.filter(l => l.includes('provider placeholder detected, retrying once'));
    expect(retryLogs).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test (d): signal emission — transport_failure, NOT format_compliance:0
// ─────────────────────────────────────────────────────────────────────────────

describe('transport_failure signal emission on placeholder dispatch', () => {
  const testDir = join(tmpdir(), 'gossip-provider-retry-signals-' + Date.now());
  const gossipDir = join(testDir, '.gossip');
  const perfFile = join(gossipDir, 'agent-performance.jsonl');

  beforeAll(() => mkdirSync(gossipDir, { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  const readSignals = () =>
    readFileSync(perfFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));

  beforeEach(() => {
    try { rmSync(perfFile); } catch { /* may not exist */ }
  });

  it('(d) placeholder result → emits transport_failure (consensus), does NOT emit format_compliance', () => {
    emitCompletionSignals(testDir, {
      agentId: 'gemini-reviewer',
      taskId: 'task-xyz',
      result: PLACEHOLDER_MALFORMED,
      elapsedMs: 1500,
      toolCalls: 3,
    });

    const sigs = readSignals();

    // Must emit transport_failure
    const transportSig = sigs.find((s: { signal: string }) => s.signal === 'transport_failure');
    expect(transportSig).toBeDefined();
    expect(transportSig.type).toBe('consensus');
    expect(transportSig.agentId).toBe('gemini-reviewer');
    expect(transportSig.taskId).toBe('task-xyz');
    expect(transportSig.evidence).toContain('malformed_function_call');

    // Must NOT emit format_compliance
    const formatSig = sigs.find((s: { signal: string }) => s.signal === 'format_compliance');
    expect(formatSig).toBeUndefined();

    // Must still emit task_completed (duration telemetry)
    const completedSig = sigs.find((s: { signal: string }) => s.signal === 'task_completed');
    expect(completedSig).toBeDefined();
    expect(completedSig.value).toBe(1500);
    // task_completed metadata should flag this as a transport failure
    expect(completedSig.metadata?.transport_failure).toBe(true);
  });
});
