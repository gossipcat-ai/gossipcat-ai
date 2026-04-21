/**
 * Unit tests for emitCompletionSignals (packages/orchestrator/src/completion-signals.ts).
 *
 * Covers:
 * - task_completed always emitted (f11: was suppressed when elapsed null)
 * - task_completed with estimated:true when elapsedMs null
 * - task_tool_turns emitted when toolCalls defined
 * - task_tool_turns NOT emitted when toolCalls undefined (F16 preserve)
 * - format_compliance always emitted WITH diagnostic_codes (f4)
 * - finding_dropped_format emitted when droppedTotal > 0 (f1)
 * - finding_dropped_format NOT emitted when nothing dropped
 * - never throws on write failure
 */

import { emitCompletionSignals, emitCitationFabricatedSignal } from '@gossip/orchestrator';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('emitCompletionSignals', () => {
  const testDir = join(tmpdir(), 'gossip-completion-signals-' + Date.now());
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

  const BASE_INPUT = {
    agentId: 'test-agent',
    taskId: 'task-abc',
    result: '',
    elapsedMs: 1234,
  };

  beforeEach(() => {
    // Reset file between tests
    try { rmSync(perfFile); } catch { /* may not exist */ }
  });

  test('emits task_completed with measured duration', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, elapsedMs: 5000 });
    const sigs = readSignals();
    const completed = sigs.find(s => s.signal === 'task_completed');
    expect(completed).toBeDefined();
    expect(completed.type).toBe('meta');
    expect(completed.value).toBe(5000);
    expect(completed.agentId).toBe('test-agent');
    expect(completed.taskId).toBe('task-abc');
    expect(completed.metadata?.estimated).toBeUndefined();
  });

  test('emits task_completed with value 0 and estimated:true when elapsedMs is null (bug f11)', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, elapsedMs: null });
    const sigs = readSignals();
    const completed = sigs.find(s => s.signal === 'task_completed');
    expect(completed).toBeDefined();
    expect(completed.value).toBe(0);
    expect(completed.metadata?.estimated).toBe(true);
  });

  test('emits task_tool_turns when toolCalls defined', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, toolCalls: 7 });
    const sigs = readSignals();
    const toolTurns = sigs.find(s => s.signal === 'task_tool_turns');
    expect(toolTurns).toBeDefined();
    expect(toolTurns.value).toBe(7);
  });

  test('does NOT emit task_tool_turns when toolCalls undefined (F16 preserve)', () => {
    // toolCalls omitted — native agent path
    emitCompletionSignals(testDir, { ...BASE_INPUT });
    const sigs = readSignals();
    const toolTurns = sigs.find(s => s.signal === 'task_tool_turns');
    expect(toolTurns).toBeUndefined();
  });

  test('emits format_compliance always with diagnostic_codes in metadata (bug f4)', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, result: '<agent_finding type="finding">...</agent_finding>' });
    const sigs = readSignals();
    const fc = sigs.find(s => s.signal === 'format_compliance');
    expect(fc).toBeDefined();
    expect(fc.type).toBe('meta');
    expect(fc.metadata).toBeDefined();
    // diagnostic_codes must be present (even if empty array)
    expect(Array.isArray(fc.metadata.diagnostic_codes)).toBe(true);
  });

  test('emits format_compliance even on empty result', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, result: '' });
    const sigs = readSignals();
    const fc = sigs.find(s => s.signal === 'format_compliance');
    expect(fc).toBeDefined();
    expect(fc.value).toBe(0); // not compliant with empty result
  });

  test('emits finding_dropped_format when tags are dropped (bug f1)', () => {
    // An agent_finding with unknown type "approval" is dropped by strict parser
    const resultWithDroppedTag = `<agent_finding type="approval" severity="high">
This is definitely long enough content to not be dropped for short-content reasons.
More content here to ensure we exceed the minimum length threshold for rejection.
</agent_finding>`;
    emitCompletionSignals(testDir, { ...BASE_INPUT, result: resultWithDroppedTag });
    const sigs = readSignals();
    const dropped = sigs.find(s => s.signal === 'finding_dropped_format');
    expect(dropped).toBeDefined();
    expect(dropped.type).toBe('pipeline');
    expect(dropped.value).toBeGreaterThan(0);
    expect(dropped.metadata?.diagnostic_codes).toBeDefined();
  });

  test('does NOT emit finding_dropped_format when nothing dropped', () => {
    // No agent_finding tags → nothing to drop
    emitCompletionSignals(testDir, { ...BASE_INPUT, result: 'Plain text result with no tags.' });
    const sigs = readSignals();
    const dropped = sigs.find(s => s.signal === 'finding_dropped_format');
    expect(dropped).toBeUndefined();
  });

  test('emits all 3 meta signals in normal case (task_completed + format_compliance + task_tool_turns)', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, result: 'result', elapsedMs: 500, toolCalls: 3 });
    const sigs = readSignals();
    const types = sigs.map(s => s.signal);
    expect(types).toContain('task_completed');
    expect(types).toContain('format_compliance');
    expect(types).toContain('task_tool_turns');
  });

  test('emits only 2 meta signals for native agents (no task_tool_turns)', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, result: 'result', elapsedMs: 500 });
    const sigs = readSignals();
    const types = sigs.map(s => s.signal);
    expect(types).toContain('task_completed');
    expect(types).toContain('format_compliance');
    expect(types).not.toContain('task_tool_turns');
  });

  test('threads memoryQueryCalled into task_tool_turns metadata', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, toolCalls: 4, memoryQueryCalled: true });
    const sigs = readSignals();
    const toolTurns = sigs.find(s => s.signal === 'task_tool_turns');
    expect(toolTurns?.metadata?.memoryQueryCalled).toBe(true);
  });

  test('never throws — invalid projectRoot path swallows error', () => {
    expect(() =>
      emitCompletionSignals('/nonexistent-path-that-cannot-exist/gossip', BASE_INPUT)
    ).not.toThrow();
  });

  test('memoryQueryCalled:false explicitly serializes as false (not undefined) in task_tool_turns metadata', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, toolCalls: 2, memoryQueryCalled: false });
    const sigs = readSignals();
    const toolTurns = sigs.find(s => s.signal === 'task_tool_turns');
    expect(toolTurns).toBeDefined();
    expect(toolTurns.metadata).toBeDefined();
    // Must be false, not undefined — explicit false means "agent had tools but did not query memory"
    expect(toolTurns.metadata.memoryQueryCalled).toBe(false);
  });

  test('error:true path — task_completed has metadata.error:true', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, elapsedMs: 3000, error: true });
    const sigs = readSignals();
    const completed = sigs.find(s => s.signal === 'task_completed');
    expect(completed).toBeDefined();
    expect(completed.value).toBe(3000);
    expect(completed.metadata?.error).toBe(true);
    expect(completed.metadata?.estimated).toBeUndefined();
  });

  test('error:true + elapsedMs:null — task_completed has both estimated:true AND error:true', () => {
    emitCompletionSignals(testDir, { ...BASE_INPUT, elapsedMs: null, error: true });
    const sigs = readSignals();
    const completed = sigs.find(s => s.signal === 'task_completed');
    expect(completed).toBeDefined();
    expect(completed.value).toBe(0);
    expect(completed.metadata?.estimated).toBe(true);
    expect(completed.metadata?.error).toBe(true);
  });
});

describe('emitCitationFabricatedSignal', () => {
  const testDir = join(tmpdir(), 'gossip-citation-fab-' + Date.now());
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

  test('emits citation_fabricated pipeline signal with correct shape', () => {
    emitCitationFabricatedSignal(testDir, {
      agentId: 'sonnet-reviewer',
      taskId: 'task-xyz',
      total: 5,
      verified: 3,
      unverifiedCitations: ['fake/one.ts:10', 'fake/two.ts:20'],
    });
    const sigs = readSignals();
    expect(sigs).toHaveLength(1);
    const sig = sigs[0];
    expect(sig.type).toBe('pipeline');
    expect(sig.signal).toBe('citation_fabricated');
    expect(sig.agentId).toBe('sonnet-reviewer');
    expect(sig.taskId).toBe('task-xyz');
    expect(sig.value).toBe(2);
    expect(sig.metadata.total).toBe(5);
    expect(sig.metadata.verified).toBe(3);
    expect(sig.metadata.unverifiedCount).toBe(2);
    expect(sig.metadata.unverifiedCitations).toEqual(['fake/one.ts:10', 'fake/two.ts:20']);
  });

  test('does NOT emit when unverifiedCitations is empty (no-op path)', () => {
    emitCitationFabricatedSignal(testDir, {
      agentId: 'sonnet-reviewer',
      taskId: 'task-clean',
      total: 3,
      verified: 3,
      unverifiedCitations: [],
    });
    // File should not exist — no signal written.
    expect(() => readFileSync(perfFile, 'utf-8')).toThrow();
  });

  test('truncates unverifiedCitations to first 10 entries', () => {
    const many = Array.from({ length: 25 }, (_, i) => `f${i}.ts:${i}`);
    emitCitationFabricatedSignal(testDir, {
      agentId: 'agent-x',
      taskId: 'task-many',
      total: 25,
      verified: 0,
      unverifiedCitations: many,
    });
    const sigs = readSignals();
    expect(sigs[0].value).toBe(25);
    expect(sigs[0].metadata.unverifiedCount).toBe(25);
    expect(sigs[0].metadata.unverifiedCitations).toHaveLength(10);
    expect(sigs[0].metadata.unverifiedCitations[0]).toBe('f0.ts:0');
    expect(sigs[0].metadata.unverifiedCitations[9]).toBe('f9.ts:9');
  });

  test('refuses reserved _system agentId', () => {
    emitCitationFabricatedSignal(testDir, {
      agentId: '_system',
      taskId: 't',
      total: 1,
      verified: 0,
      unverifiedCitations: ['x.ts'],
    });
    expect(() => readFileSync(perfFile, 'utf-8')).toThrow();
  });

  test('never throws on write failure', () => {
    expect(() =>
      emitCitationFabricatedSignal('/nonexistent-path-that-cannot-exist/gossip', {
        agentId: 'a',
        taskId: 't',
        total: 1,
        verified: 0,
        unverifiedCitations: ['x'],
      })
    ).not.toThrow();
  });
});
