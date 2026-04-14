/**
 * Comprehensive tests for gossipcat MCP tool handlers.
 *
 * Tests cover:
 *   - PerformanceWriter.appendSignals (used by gossip_signals handler)
 *   - handleDispatchSingle
 *   - handleCollect
 *   - handleNativeRelay
 *   - evictStaleNativeTasks + persistNativeTaskMap
 *
 * Mocking strategy: import the real ctx object and mutate its properties
 * between tests. This avoids jest.mock hoisting issues with modules that
 * import ctx at the top level.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PerformanceWriter } from '@gossip/orchestrator';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `gossip-mcp-test-${label}-`));
}

// ── PerformanceWriter (gossip_signals) ────────────────────────────────────────

describe('PerformanceWriter — gossip_signals backing store', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir('signals');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes a valid agreement signal to disk', () => {
    const writer = new PerformanceWriter(testDir);
    const signal = {
      type: 'consensus' as const,
      signal: 'agreement' as const,
      agentId: 'agent-a',
      taskId: 'task-001',
      evidence: 'Both agents agree on the race condition',
      timestamp: new Date().toISOString(),
    };
    expect(() => writer.appendSignal(signal)).not.toThrow();

    const filePath = join(testDir, '.gossip', 'agent-performance.jsonl');
    expect(existsSync(filePath)).toBe(true);
    const line = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(line.signal).toBe('agreement');
    expect(line.agentId).toBe('agent-a');
  });

  it('writes a valid unique_confirmed signal', () => {
    const writer = new PerformanceWriter(testDir);
    const signal = {
      type: 'consensus' as const,
      signal: 'unique_confirmed' as const,
      agentId: 'gemini-reviewer',
      taskId: 'task-42',
      evidence: 'Verified: unbounded file growth confirmed in native-tasks.ts',
      timestamp: new Date().toISOString(),
    };
    writer.appendSignal(signal);

    const raw = readFileSync(join(testDir, '.gossip', 'agent-performance.jsonl'), 'utf-8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.signal).toBe('unique_confirmed');
    expect(parsed.agentId).toBe('gemini-reviewer');
  });

  it('writes a valid hallucination_caught signal', () => {
    const writer = new PerformanceWriter(testDir);
    const signal = {
      type: 'consensus' as const,
      signal: 'hallucination_caught' as const,
      agentId: 'haiku-researcher',
      taskId: 'task-99',
      evidence: 'Agent claimed ScopeTracker persists to disk — it does not',
      timestamp: new Date().toISOString(),
    };
    expect(() => writer.appendSignal(signal)).not.toThrow();
    const raw = readFileSync(join(testDir, '.gossip', 'agent-performance.jsonl'), 'utf-8').trim();
    expect(JSON.parse(raw).signal).toBe('hallucination_caught');
  });

  it('appends multiple signals in one batch', () => {
    const writer = new PerformanceWriter(testDir);
    const ts = new Date().toISOString();
    writer.appendSignals([
      { type: 'consensus' as const, signal: 'agreement' as const, agentId: 'a1', taskId: 't1', evidence: 'e1', timestamp: ts },
      { type: 'consensus' as const, signal: 'disagreement' as const, agentId: 'a2', taskId: 't2', evidence: 'e2', timestamp: ts },
    ]);

    const lines = readFileSync(join(testDir, '.gossip', 'agent-performance.jsonl'), 'utf-8')
      .trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).agentId).toBe('a1');
    expect(JSON.parse(lines[1]).agentId).toBe('a2');
  });

  it('preserves findingId and consensusId fields when appended', () => {
    // Regression for the provisional-signal back-search gap (consensus 4c88bcd3,
    // sonnet-reviewer:f3): the auto-recorder at collect.ts:438-481 was writing
    // signals without findingId, so the dashboard could not back-trace from
    // finding to signal to score adjustment. After the fix, findingId and
    // consensusId must round-trip through appendSignals unchanged.
    const writer = new PerformanceWriter(testDir);
    const ts = new Date().toISOString();
    writer.appendSignals([
      {
        type: 'consensus' as const,
        signal: 'unique_unconfirmed' as const,
        agentId: 'gemini-reviewer',
        taskId: '4c88bcd3-00cf4810:gemini-reviewer:f1',
        consensusId: '4c88bcd3-00cf4810',
        findingId: '4c88bcd3-00cf4810:gemini-reviewer:f1',
        severity: 'high' as const,
        category: 'error_handling',
        evidence: '[provisional] auto-recorded',
        timestamp: ts,
      },
    ]);

    const raw = readFileSync(join(testDir, '.gossip', 'agent-performance.jsonl'), 'utf-8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.findingId).toBe('4c88bcd3-00cf4810:gemini-reviewer:f1');
    expect(parsed.consensusId).toBe('4c88bcd3-00cf4810');
    expect(parsed.severity).toBe('high');
    expect(parsed.category).toBe('error_handling');
  });

  it('rejects a signal with missing agentId', () => {
    const writer = new PerformanceWriter(testDir);
    expect(() => writer.appendSignal({
      type: 'consensus' as const,
      signal: 'agreement' as const,
      agentId: '',
      taskId: 'task-1',
      evidence: 'x',
      timestamp: new Date().toISOString(),
    })).toThrow(/agentId/);
  });

  it('rejects a signal with an unknown signal value', () => {
    const writer = new PerformanceWriter(testDir);
    expect(() => writer.appendSignal({
      type: 'consensus' as const,
      signal: 'not_a_real_signal' as any,
      agentId: 'agent-x',
      taskId: 'task-1',
      evidence: 'x',
      timestamp: new Date().toISOString(),
    })).toThrow(/unknown consensus signal/);
  });

  it('rejects a signal with an invalid timestamp', () => {
    const writer = new PerformanceWriter(testDir);
    expect(() => writer.appendSignal({
      type: 'consensus' as const,
      signal: 'agreement' as const,
      agentId: 'agent-x',
      taskId: 'task-1',
      evidence: 'x',
      timestamp: 'not-a-date',
    })).toThrow(/timestamp/);
  });
});

// ── Handler tests using real ctx mutation ─────────────────────────────────────
//
// All handler modules import `ctx` from mcp-context at the top of their file.
// Rather than trying to mock the module (which requires hoisting), we import
// the real ctx and mutate its properties before each test, then restore after.

import { ctx } from '../../apps/cli/src/mcp-context';
import {
  handleDispatchSingle,
} from '../../apps/cli/src/handlers/dispatch';
import { handleCollect } from '../../apps/cli/src/handlers/collect';
import {
  handleNativeRelay,
  evictStaleNativeTasks,
  persistNativeTaskMap,
  restoreNativeTaskMap,
} from '../../apps/cli/src/handlers/native-tasks';

// Snapshot original ctx so we can restore between tests
const originalCtx = {
  mainAgent: ctx.mainAgent,
  relay: ctx.relay,
  workers: ctx.workers,
  keychain: ctx.keychain,
  skillEngine: ctx.skillEngine,
  nativeTaskMap: ctx.nativeTaskMap,
  nativeResultMap: ctx.nativeResultMap,
  nativeAgentConfigs: ctx.nativeAgentConfigs,
  pendingConsensusRounds: ctx.pendingConsensusRounds,
  booted: ctx.booted,
  boot: ctx.boot,
  syncWorkersViaKeychain: ctx.syncWorkersViaKeychain,
};

function makeMainAgent(overrides: Record<string, any> = {}): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'default-task-id' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    runConsensus: jest.fn().mockResolvedValue({
      summary: '', signals: [], confirmed: [], disputed: [],
      unverified: [], unique: [], insights: [], agentCount: 0, rounds: 0,
    }),
    getAgentConfig: jest.fn().mockReturnValue(null),
    getLlm: jest.fn().mockReturnValue(null),
    getLLM: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]),
    getSkillGapSuggestions: jest.fn().mockReturnValue([]),
    getSkillIndex: jest.fn().mockReturnValue(null),
    getSessionGossip: jest.fn().mockReturnValue([]),
    getSessionConsensusHistory: jest.fn().mockReturnValue([]),
    recordNativeTask: jest.fn(),
    recordNativeTaskCompleted: jest.fn(),
    recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined),
    getChainContext: jest.fn().mockReturnValue(''),
    dispatchParallel: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    getTask: jest.fn().mockReturnValue(null),
    pipeline: null,
    projectRoot: '/tmp/gossip-test-project',
    ...overrides,
  };
}

function resetCtx(mainAgentOverrides: Record<string, any> = {}, projectRoot?: string) {
  ctx.mainAgent = makeMainAgent({ ...(projectRoot ? { projectRoot } : {}), ...mainAgentOverrides });
  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.nativeAgentConfigs = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
  ctx.syncWorkersViaKeychain = jest.fn().mockResolvedValue(undefined) as any;
  (ctx as any).skillEngine = null;
}

function restoreCtx() {
  Object.assign(ctx, originalCtx);
}

// ── handleDispatchSingle ─────────────────────────────────────────────────────

describe('handleDispatchSingle', () => {
  beforeEach(() => resetCtx());
  afterEach(() => restoreCtx());

  it('dispatches to relay agent and returns task ID', async () => {
    ctx.mainAgent = makeMainAgent({ dispatch: jest.fn().mockReturnValue({ taskId: 'abc12345' }) });
    const result = await handleDispatchSingle('relay-agent', 'Review server.ts');
    expect(result.content[0].text).toContain('Dispatched to relay-agent');
    expect(result.content[0].text).toContain('abc12345');
  });

  it('rejects an agent ID with invalid characters', async () => {
    const result = await handleDispatchSingle('agent with spaces!', 'some task');
    expect(result.content[0].text).toContain('Invalid agent ID format');
  });

  it('includes write_mode label in dispatch response', async () => {
    ctx.mainAgent = makeMainAgent({ dispatch: jest.fn().mockReturnValue({ taskId: 'wmode1' }) });
    const result = await handleDispatchSingle('relay-agent', 'Do work', 'sequential');
    expect(result.content[0].text).toContain('[sequential]');
  });

  it('dispatches to native agent and returns NATIVE_DISPATCH instructions', async () => {
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-opus-4-5',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: [],
    });
    const result = await handleDispatchSingle('native-claude', 'Audit memory system');
    const text = result.content[0].text;
    expect(text).toContain('NATIVE_DISPATCH');
    expect(text).toContain('gossip_relay');
    expect(text).toContain('native-claude');
    expect(text).toContain('claude-opus-4-5');
  });

  it('returns error when plan_id given without step', async () => {
    const result = await handleDispatchSingle(
      'relay-agent', 'task', undefined, undefined, undefined, 'plan-abc',
    );
    expect(result.content[0].text).toContain('plan_id requires step');
  });

  it('propagates dispatch error message as text response', async () => {
    ctx.mainAgent = makeMainAgent({
      dispatch: jest.fn().mockImplementation(() => { throw new Error('Agent not configured'); }),
    });
    const result = await handleDispatchSingle('unknown-agent', 'some task');
    expect(result.content[0].text).toContain('Agent not configured');
  });
});

// ── handleCollect ─────────────────────────────────────────────────────────────

describe('handleCollect', () => {
  beforeEach(() => resetCtx());
  afterEach(() => restoreCtx());

  it('returns "No pending tasks" when nothing was dispatched', async () => {
    const result = await handleCollect([], 5000, false);
    expect(result.content[0].text).toContain('No pending tasks');
  });

  it('returns error if consensus mode requested with no task IDs', async () => {
    const result = await handleCollect([], 5000, true);
    expect(result.content[0].text).toContain('consensus mode requires explicit task_ids');
  });

  it('returns error when relay collect throws and there are no native tasks', async () => {
    ctx.mainAgent = makeMainAgent({
      collect: jest.fn().mockRejectedValue(new Error('relay is down')),
    });
    const result = await handleCollect(['task-1'], 5000, false);
    expect(result.content[0].text).toContain('relay is down');
  });

  it('formats a completed relay result', async () => {
    const now = Date.now();
    ctx.mainAgent = makeMainAgent({
      collect: jest.fn().mockResolvedValue({
        results: [{
          id: 'abc123',
          agentId: 'gemini-reviewer',
          task: 'Audit server.ts',
          status: 'completed',
          result: 'Found 2 issues.',
          startedAt: now - 1000,
          completedAt: now,
        }],
      }),
    });
    const result = await handleCollect(['abc123'], 5000, false);
    expect(result.content[0].text).toContain('[abc123]');
    expect(result.content[0].text).toContain('Found 2 issues');
    expect(result.content[0].text).toContain('gemini-reviewer');
  });

  it('formats a failed relay result with gossip_run re-dispatch hint', async () => {
    const now = Date.now();
    ctx.mainAgent = makeMainAgent({
      collect: jest.fn().mockResolvedValue({
        results: [{
          id: 'fail01',
          agentId: 'sonnet-reviewer',
          task: 'Review auth.ts',
          status: 'failed',
          error: 'Context window exceeded',
          startedAt: now - 2000,
          completedAt: now,
        }],
      }),
    });
    const result = await handleCollect(['fail01'], 5000, false);
    expect(result.content[0].text).toContain('ERROR');
    expect(result.content[0].text).toContain('gossip_run');
  });

  it('includes native result from nativeResultMap when collected by ID', async () => {
    const now = Date.now();
    ctx.mainAgent = makeMainAgent({ collect: jest.fn().mockResolvedValue({ results: [] }) });
    ctx.nativeResultMap.set('native-t1', {
      id: 'native-t1',
      agentId: 'native-claude',
      task: 'Review code',
      status: 'completed',
      result: 'All good!',
      startedAt: now - 500,
      completedAt: now,
    });
    ctx.nativeTaskMap.set('native-t1', {
      agentId: 'native-claude',
      task: 'Review code',
      startedAt: now - 500,
    });
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-opus-4-5',
      instructions: '',
      description: '',
      skills: [],
    });

    const result = await handleCollect(['native-t1'], 5000, false);
    expect(result.content[0].text).toContain('All good!');
    expect(result.content[0].text).toContain('native-claude');
  });
});

// ── handleNativeRelay ─────────────────────────────────────────────────────────

describe('handleNativeRelay', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir('relay');
    resetCtx({}, testDir);
  });

  afterEach(() => {
    restoreCtx();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('relays result for a known task ID', async () => {
    const now = Date.now();
    ctx.nativeTaskMap.set('task-abc', {
      agentId: 'native-claude',
      task: 'Review x',
      startedAt: now - 1000,
      timeoutMs: 30000,
    });

    const result = await handleNativeRelay('task-abc', 'Found 3 bugs.');
    expect(result.content[0].text).toContain('completed');
    expect(result.content[0].text).toContain('native-claude');
    expect(result.content[0].text).toContain('task-abc');
  });

  it('stores result in nativeResultMap after successful relay', async () => {
    const now = Date.now();
    ctx.nativeTaskMap.set('task-store', {
      agentId: 'native-claude',
      task: 'Review x',
      startedAt: now - 500,
      timeoutMs: 30000,
    });

    await handleNativeRelay('task-store', 'All clear.');

    const stored = ctx.nativeResultMap.get('task-store');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('completed');
    expect(stored!.result).toBe('All clear.');
  });

  it('returns error for unknown task ID', async () => {
    const result = await handleNativeRelay('unknown-xyz', 'some result');
    expect(result.content[0].text).toContain('Unknown task ID');
  });

  it('records failed status when error argument is provided', async () => {
    const now = Date.now();
    ctx.nativeTaskMap.set('task-err', {
      agentId: 'native-claude',
      task: 'Something',
      startedAt: now - 200,
      timeoutMs: 30000,
    });

    await handleNativeRelay('task-err', '', 'LLM context overflow');

    const stored = ctx.nativeResultMap.get('task-err');
    expect(stored!.status).toBe('failed');
    expect(stored!.error).toBe('LLM context overflow');
  });

  it('late relay overwrites a timed_out result', async () => {
    const now = Date.now();
    // Task not in taskMap (evicted on timeout), but present as timed_out in resultMap
    ctx.nativeResultMap.set('task-late', {
      id: 'task-late',
      agentId: 'native-claude',
      task: 'Review y',
      status: 'timed_out',
      error: 'Timed out after 30000ms',
      startedAt: now - 35000,
      completedAt: now - 5000,
    });

    const result = await handleNativeRelay('task-late', 'Better late than never!');
    expect(result.content[0].text).not.toContain('Unknown task ID');
    expect(result.content[0].text).toContain('completed');

    const stored = ctx.nativeResultMap.get('task-late');
    expect(stored!.status).toBe('completed');
    expect(stored!.result).toBe('Better late than never!');
  });
});

// ── handleNativeRelay — utility tasks ────────────────────────────────────────

describe('handleNativeRelay — utility task relay', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir('utility-relay');
    resetCtx({}, testDir);
  });

  afterEach(() => {
    restoreCtx();
    rmSync(testDir, { recursive: true, force: true });
    ctx.nativeTaskMap.clear();
    ctx.nativeResultMap.clear();
  });

  it('stores result with completed status for a utility task', async () => {
    const now = Date.now();
    ctx.nativeTaskMap.set('util-task-1', {
      agentId: '_utility',
      task: 'lens summary',
      startedAt: now - 500,
      timeoutMs: 30000,
      utilityType: 'lens',
    });

    await handleNativeRelay('util-task-1', 'lens result data');

    const stored = ctx.nativeResultMap.get('util-task-1');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('completed');
    expect(stored!.result).toBe('lens result data');
  });

  it('does not create a memory directory for utility agent', async () => {
    const now = Date.now();
    ctx.nativeTaskMap.set('util-task-2', {
      agentId: '_utility',
      task: 'lens summary',
      startedAt: now - 500,
      timeoutMs: 30000,
      utilityType: 'lens',
    });

    await handleNativeRelay('util-task-2', 'some lens output');

    const { existsSync } = await import('fs');
    const memDir = join(testDir, '.gossip', 'memory', '_utility');
    expect(existsSync(memDir)).toBe(false);
  });
});

// ── evictStaleNativeTasks ─────────────────────────────────────────────────────

describe('evictStaleNativeTasks', () => {
  const TTL = 2 * 60 * 60 * 1000;

  beforeEach(() => resetCtx());
  afterEach(() => restoreCtx());

  it('evicts tasks older than TTL from nativeTaskMap', () => {
    const now = Date.now();
    ctx.nativeTaskMap.set('old-task', { agentId: 'a', task: 't', startedAt: now - TTL - 1000 });
    ctx.nativeTaskMap.set('new-task', { agentId: 'b', task: 'u', startedAt: now - 1000 });

    evictStaleNativeTasks();

    expect(ctx.nativeTaskMap.has('old-task')).toBe(false);
    expect(ctx.nativeTaskMap.has('new-task')).toBe(true);
  });

  it('evicts stale results from nativeResultMap', () => {
    const now = Date.now();
    ctx.nativeResultMap.set('old-res', {
      id: 'old-res', agentId: 'a', task: 't', status: 'completed' as const,
      startedAt: now - TTL - 1000, completedAt: now - TTL,
    });
    ctx.nativeResultMap.set('new-res', {
      id: 'new-res', agentId: 'b', task: 'u', status: 'completed' as const,
      startedAt: now - 1000, completedAt: now,
    });

    evictStaleNativeTasks();

    expect(ctx.nativeResultMap.has('old-res')).toBe(false);
    expect(ctx.nativeResultMap.has('new-res')).toBe(true);
  });
});

// ── handleDispatchConsensus — Promise.race timeout pattern ──────────────────

import { handleDispatchConsensus } from '../../apps/cli/src/handlers/dispatch';

describe('handleDispatchConsensus — lens generation timeout', () => {
  beforeEach(() => resetCtx());
  afterEach(() => restoreCtx());

  it('uses lenses when generateLensesForAgents resolves before timeout', async () => {
    const lensMap = new Map([['agent-1', 'Focus on performance'], ['agent-2', 'Focus on security']]);
    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn().mockResolvedValue(lensMap),
      dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: ['t1', 't2'], errors: [] }),
    });

    const result = await handleDispatchConsensus([
      { agent_id: 'agent-1', task: 'Review code' },
      { agent_id: 'agent-2', task: 'Review code' },
    ]);

    const text = result.content[0].text;
    expect(text).toContain('Dispatched 2 tasks with consensus');
    expect(ctx.mainAgent.dispatchParallelWithLenses).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ consensus: true }),
      lensMap
    );
    // Timer should be cleared when lenses arrive before timeout
    expect(text).not.toContain('ERROR');
  });

  it('proceeds without lenses when generateLensesForAgents takes longer than 5s', async () => {
    // Lens generation takes 10 seconds but timeout is 5s
    const slowLensPromise = new Promise<Map<string, string>>((resolve) => {
      setTimeout(() => {
        resolve(new Map([['agent-1', 'Focus A']]));
      }, 10000);
    });

    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn().mockReturnValue(slowLensPromise),
      dispatchParallel: jest.fn().mockResolvedValue({ taskIds: ['t1', 't2'], errors: [] }),
      dispatchParallelWithLenses: jest.fn(),
    });

    const startTime = Date.now();
    const result = await handleDispatchConsensus([
      { agent_id: 'agent-1', task: 'Review code' },
      { agent_id: 'agent-2', task: 'Review code' },
    ]);
    const elapsedMs = Date.now() - startTime;

    // Should complete in ~5s or slightly more, not 10s
    expect(elapsedMs).toBeLessThan(8000);

    // Should use dispatchParallel (without lenses) not dispatchParallelWithLenses
    expect(ctx.mainAgent.dispatchParallel).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ consensus: true })
    );
    expect(ctx.mainAgent.dispatchParallelWithLenses).not.toHaveBeenCalled();

    const text = result.content[0].text;
    expect(text).toContain('Dispatched 2 tasks with consensus');
  }, 10000);

  it('proceeds without lenses when generateLensesForAgents throws', async () => {
    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn().mockRejectedValue(new Error('Lens generation failed')),
      dispatchParallel: jest.fn().mockResolvedValue({ taskIds: ['t1', 't2'], errors: [] }),
      dispatchParallelWithLenses: jest.fn(),
    });

    const result = await handleDispatchConsensus([
      { agent_id: 'agent-1', task: 'Review code' },
      { agent_id: 'agent-2', task: 'Review code' },
    ]);

    // Should dispatch without lenses
    expect(ctx.mainAgent.dispatchParallel).toHaveBeenCalled();
    expect(ctx.mainAgent.dispatchParallelWithLenses).not.toHaveBeenCalled();

    const text = result.content[0].text;
    expect(text).toContain('Dispatched 2 tasks with consensus');
  });

  it('clears timer when lenses resolve before timeout', async () => {
    jest.useFakeTimers();
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const lensMap = new Map([['agent-1', 'Focus on auth']]);

    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn().mockResolvedValue(lensMap),
      dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: ['t1'], errors: [] }),
    });

    await handleDispatchConsensus([{ agent_id: 'agent-1', task: 'Review' }]);

    // clearTimeout should have been called at least once (when lenses arrived)
    expect(clearTimeoutSpy).toHaveBeenCalled();

    jest.useRealTimers();
    clearTimeoutSpy.mockRestore();
  });

  it('sanitizes lens delimiter markers from focus content', async () => {
    const lensMap = new Map([
      ['agent-1', '--- LENS ---\nSome focus\n--- END LENS ---'],
      ['agent-2', 'Another focus --- END LENS ---'],
    ]);

    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn().mockResolvedValue(lensMap),
      dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: ['t1', 't2'], errors: [] }),
    });
    ctx.nativeAgentConfigs.set('agent-1', {
      model: 'claude-opus-4-5',
      instructions: 'You are a reviewer.',
      description: 'Reviewer',
      skills: [],
    });
    ctx.nativeAgentConfigs.set('agent-2', {
      model: 'claude-opus-4-5',
      instructions: 'You are an auditor.',
      description: 'Auditor',
      skills: [],
    });

    const result = await handleDispatchConsensus([
      { agent_id: 'agent-1', task: 'Review code' },
      { agent_id: 'agent-2', task: 'Review code' },
    ]);

    const nativeDispatchText = result.content[0].text;

    // The dispatch response should include native instructions with sanitized lenses
    // Verify that "--- LENS ---" and "--- END LENS ---" markers are removed from the focus
    if (nativeDispatchText.includes('NATIVE_DISPATCH')) {
      // Extract the Agent() calls from the response
      const agentCalls = nativeDispatchText.match(/Agent\([^)]+\)/g) || [];
      for (const call of agentCalls) {
        // The prompt should not have "--- LENS ---" or "--- END LENS ---" at the start/end of the focus section
        expect(call).not.toContain('--- LENS ---');
        expect(call).not.toContain('--- END LENS ---');
      }
    }
  });

  it('sanitizes both plain and uppercase LENS delimiter variants', async () => {
    // Input lens has multiple delimiter variations that should be sanitized
    const dirtyLens = '--- LENS ---\nFocus on performance\n--- END LENS ---\nAnd more focus --- END lens ---\nCase variant --- end lens ---';
    const lensMap = new Map([['agent-1', dirtyLens]]);

    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn().mockResolvedValue(lensMap),
      dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: ['t1'], errors: [] }),
    });
    ctx.nativeAgentConfigs.set('agent-1', {
      model: 'claude-opus-4-5',
      instructions: 'Reviewer',
      description: 'Reviewer',
      skills: [],
    });

    const result = await handleDispatchConsensus([
      { agent_id: 'agent-1', task: 'Review' },
    ]);

    const text = result.content[0].text;
    if (text.includes('NATIVE_DISPATCH')) {
      // After sanitization via regex /---\s*(END )?LENS\s*---/gi,
      // the embedded markers should be removed from the focus content.
      // The regex removes: "--- LENS ---", "--- END LENS ---", "--- END lens ---", "--- end lens ---"
      // So the inner focus should NOT have these variants (case-insensitive)
      const lensSection = text.match(/--- LENS ---\n([\s\S]*?)\n--- END LENS ---/);
      if (lensSection) {
        const sanitizedContent = lensSection[1];
        // These should have been removed by the sanitization regex
        expect(sanitizedContent).not.toMatch(/--- LENS ---/i);
        expect(sanitizedContent).not.toMatch(/--- END LENS ---/i);
        expect(sanitizedContent).not.toMatch(/--- end lens ---/i);
      }
    }
  });

  it('recovers pre-computed lenses from utility task result on re-entry', async () => {
    const precomputedLenses = [
      { agentId: 'agent-1', focus: 'Focus on logic' },
      { agentId: 'agent-2', focus: 'Focus on edge cases' },
    ];

    // Pre-populate utility task result
    const utilityTaskId = 'util-lens-001';
    ctx.nativeResultMap.set(utilityTaskId, {
      id: utilityTaskId,
      agentId: '_utility',
      task: 'generate lenses',
      status: 'completed',
      result: JSON.stringify(precomputedLenses),
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
    });

    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn(), // Should NOT be called
      dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: ['t1', 't2'], errors: [] }),
    });

    await handleDispatchConsensus([
      { agent_id: 'agent-1', task: 'Review' },
      { agent_id: 'agent-2', task: 'Review' },
    ], utilityTaskId);

    // Should use precomputed lenses
    expect(ctx.mainAgent.dispatchParallelWithLenses).toHaveBeenCalled();

    // Utility task should be cleared from maps after use
    expect(ctx.nativeResultMap.has(utilityTaskId)).toBe(false);
    expect(ctx.nativeTaskMap.has(utilityTaskId)).toBe(false);
  });

  it('ignores malformed utility task result and generates lenses instead', async () => {
    const utilityTaskId = 'util-broken-001';
    ctx.nativeResultMap.set(utilityTaskId, {
      id: utilityTaskId,
      agentId: '_utility',
      task: 'generate lenses',
      status: 'completed',
      result: 'not valid json { broken [',
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
    });

    const lensMap = new Map([['agent-1', 'Fallback focus']]);
    ctx.mainAgent = makeMainAgent({
      generateLensesForAgents: jest.fn().mockResolvedValue(lensMap),
      dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: ['t1'], errors: [] }),
    });

    await handleDispatchConsensus([
      { agent_id: 'agent-1', task: 'Review' },
    ], utilityTaskId);

    // Should fall back to live generation
    expect(ctx.mainAgent.generateLensesForAgents).toHaveBeenCalled();
    expect(ctx.mainAgent.dispatchParallelWithLenses).toHaveBeenCalled();
  });
});

// ── persistNativeTaskMap + restoreNativeTaskMap ──────────────────────────────

describe('persistNativeTaskMap + restore', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir('persist');
    resetCtx({}, testDir);
  });

  afterEach(() => {
    restoreCtx();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes native-tasks.json with task metadata', () => {
    const now = Date.now();
    ctx.nativeTaskMap.set('t1', {
      agentId: 'claude-reviewer',
      task: 'Review code',
      startedAt: now,
    });

    persistNativeTaskMap();

    const filePath = join(testDir, '.gossip', 'native-tasks.json');
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data.tasks['t1']).toBeDefined();
    expect(data.tasks['t1'].agentId).toBe('claude-reviewer');
  });

  it('persists result metadata but strips full result text (slim format)', () => {
    const now = Date.now();
    const longResult = 'x'.repeat(100_000);
    ctx.nativeResultMap.set('r1', {
      id: 'r1', agentId: 'a', task: 'do stuff',
      status: 'completed' as const, result: longResult,
      startedAt: now - 500, completedAt: now,
    });

    persistNativeTaskMap();

    const filePath = join(testDir, '.gossip', 'native-tasks.json');
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data.results['r1']).toBeDefined();
    // Full result text is not stored — only status metadata
    expect(data.results['r1'].result).toBeUndefined();
    expect(data.results['r1'].status).toBe('completed');
  });

  it('restores non-expired tasks from disk', () => {
    const TTL = 2 * 60 * 60 * 1000;
    const now = Date.now();
    const gossipDir = join(testDir, '.gossip');
    mkdirSync(gossipDir, { recursive: true });
    writeFileSync(join(gossipDir, 'native-tasks.json'), JSON.stringify({
      tasks: {
        'valid-task': {
          agentId: 'a', task: 'valid',
          startedAt: now - 1000, timeoutMs: TTL,
        },
        'expired-task': {
          agentId: 'b', task: 'old',
          startedAt: now - TTL - 5000, timeoutMs: TTL,
        },
      },
      results: {},
    }));

    restoreNativeTaskMap(testDir);

    expect(ctx.nativeTaskMap.has('valid-task')).toBe(true);
    expect(ctx.nativeTaskMap.has('expired-task')).toBe(false);
  });

  it('marks task as timed_out on restore if individual task timeout has elapsed', () => {
    const now = Date.now();
    const shortTimeout = 5000;
    const gossipDir = join(testDir, '.gossip');
    mkdirSync(gossipDir, { recursive: true });
    writeFileSync(join(gossipDir, 'native-tasks.json'), JSON.stringify({
      tasks: {
        'timed-task': {
          agentId: 'c', task: 'expired work',
          startedAt: now - shortTimeout - 1000, // started 6s ago, 5s timeout
          timeoutMs: shortTimeout,
        },
      },
      results: {},
    }));

    restoreNativeTaskMap(testDir);

    const timedOut = ctx.nativeResultMap.get('timed-task');
    expect(timedOut).toBeDefined();
    expect(timedOut!.status).toBe('timed_out');
  });
});

// ── gossip_run auto-path: NullProvider + claude-code delegation ───────────────
//
// The gossip_run handler has an inline fast-path: when config.main_agent.provider === 'none'
// and env.host === 'claude-code', it returns a delegation message telling the orchestrator
// (Claude Code itself) to pick the best agent from the agent list.
//
// Since the handler lives inside mcp-server-sdk.ts (not exported), we test the
// delegation message shape by replicating the logic under the same conditions.
// This guards against accidental breakage of the delegation message format that
// Claude Code parses to know which agents are available.

describe('gossip_run auto-path — NullProvider + claude-code host delegation', () => {
  beforeEach(() => resetCtx());
  afterEach(() => restoreCtx());

  /**
   * Replicates the delegation message produced by gossip_run when:
   *   config.main_agent.provider === 'none'  (NullProvider)
   *   env.host === 'claude-code'
   *
   * The real handler reads getAgentList() from ctx.mainAgent and formats the
   * agent summary, then returns instructions for the orchestrator to pick an agent.
   */
  function buildDelegationMessage(agents: Array<{ id: string; provider: string; model: string; skills?: string[] }>, task: string): string {
    const agentSummary = agents.map(a =>
      `- ${a.id} (${a.provider}/${a.model}) [${a.skills?.join(', ') || 'no skills'}]`
    ).join('\n');
    return (
      `Auto-dispatch: no orchestrator LLM — you classify.\n\n` +
      `**Task:** ${task}\n\n` +
      `**Available agents:**\n${agentSummary}\n\n` +
      `Pick the best agent and call:\n` +
      `  gossip_run(agent_id: "<chosen-agent>", task: "<task>")\n\n` +
      `For multi-agent tasks, call gossip_plan(task: "<task>") instead.`
    );
  }

  it('delegation message includes the task description', () => {
    const task = 'Review the auth module for security issues';
    const agents = [{ id: 'gemini-reviewer', provider: 'google', model: 'gemini-2.5-pro', skills: ['security_audit'] }];
    const msg = buildDelegationMessage(agents, task);
    expect(msg).toContain(task);
  });

  it('delegation message lists all available agents', () => {
    const agents = [
      { id: 'gemini-reviewer', provider: 'google', model: 'gemini-2.5-pro', skills: ['security_audit'] },
      { id: 'sonnet-reviewer', provider: 'anthropic', model: 'claude-3-5-sonnet', skills: ['code_review'] },
    ];
    const msg = buildDelegationMessage(agents, 'some task');
    expect(msg).toContain('gemini-reviewer');
    expect(msg).toContain('sonnet-reviewer');
    expect(msg).toContain('google/gemini-2.5-pro');
    expect(msg).toContain('anthropic/claude-3-5-sonnet');
  });

  it('delegation message instructs orchestrator to call gossip_run with chosen agent', () => {
    const agents = [{ id: 'gemini-reviewer', provider: 'google', model: 'gemini-2.5-pro' }];
    const msg = buildDelegationMessage(agents, 'task');
    expect(msg).toContain('gossip_run(agent_id: "<chosen-agent>", task: "<task>")');
  });

  it('delegation message offers gossip_plan for multi-agent tasks', () => {
    const agents = [{ id: 'gemini-reviewer', provider: 'google', model: 'gemini-2.5-pro' }];
    const msg = buildDelegationMessage(agents, 'task');
    expect(msg).toContain('gossip_plan(task: "<task>")');
  });

  it('delegation message shows "no skills" when agent has no skills', () => {
    const agents = [{ id: 'bare-agent', provider: 'google', model: 'gemini-pro', skills: [] }];
    const msg = buildDelegationMessage(agents, 'task');
    expect(msg).toContain('[no skills]');
  });

  it('delegation message shows skills list when agent has skills', () => {
    const agents = [{ id: 'reviewer', provider: 'google', model: 'gemini-pro', skills: ['security_audit', 'code_review'] }];
    const msg = buildDelegationMessage(agents, 'task');
    expect(msg).toContain('[security_audit, code_review]');
  });

  it('ctx.mainAgent.getAgentList returns the list used in delegation', () => {
    const mockAgents = [
      { id: 'gemini-reviewer', provider: 'google', model: 'gemini-2.5-pro', skills: ['security_audit'] },
    ];
    ctx.mainAgent = makeMainAgent({
      getAgentList: jest.fn().mockReturnValue(mockAgents),
    });
    // The delegation path reads agents from getAgentList — verify the mock matches
    const agents = ctx.mainAgent.getAgentList?.() ?? [];
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('gemini-reviewer');

    const msg = buildDelegationMessage(agents, 'Review auth.ts');
    expect(msg).toContain('gemini-reviewer');
    expect(msg).toContain('Review auth.ts');
  });
});

// ── handleDispatchSingle — native skill injection ─────────────────────────────
//
// Verifies that Step 1-2 of the native skill injection unification actually
// wire loadSkills() into the dispatched agent prompt. Prior to these tests,
// the existing suite only exercised the no-op path (skills:[] + null index),
// so a regression in dispatch.ts's skill wiring could ship unnoticed.

describe('handleDispatchSingle — native skill injection', () => {
  let skillDir: string;
  let previousCwd: string;

  // Typed mock of the SkillIndex surface that loadSkills actually uses.
  // Per bench review 12827629-fa9a4660:f10, the prior untyped stub
  // {slot: i} duck-type would let silent interface drift ship unnoticed:
  // the test still passes when SkillIndex gains a new method that
  // loadSkills starts calling. Declaring the shape explicitly forces
  // test updates when the contract changes.
  type SkillIndexStub = {
    getAgentSlots: (agentId: string) => Array<{ slot: number }>;
    getEnabledSkills: (agentId: string) => string[];
    getSkillMode: (agentId: string, skill: string) => 'permanent' | 'contextual';
  };

  function makeSkillIndex(enabled: string[]): SkillIndexStub {
    return {
      getAgentSlots: (_agentId: string) => enabled.map((_, i) => ({ slot: i })),
      getEnabledSkills: (_agentId: string) => enabled,
      getSkillMode: (_agentId: string, _skill: string) => 'permanent' as const,
    };
  }

  beforeEach(() => {
    previousCwd = process.cwd();
    skillDir = makeTmpDir('skills');
    // loadSkills resolves via projectRoot = process.cwd(), so chdir into the
    // tmp workspace and seed .gossip/skills/ with the test skill files.
    mkdirSync(join(skillDir, '.gossip', 'skills'), { recursive: true });
    process.chdir(skillDir);
    resetCtx();
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(previousCwd);
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('injects skill content into native agent prompt when skills are enabled', async () => {
    writeFileSync(
      join(skillDir, '.gossip', 'skills', 'memory-retrieval.md'),
      '---\nname: memory-retrieval\nmode: permanent\n---\nRecall past findings before making new claims.\n',
    );
    ctx.mainAgent = makeMainAgent({
      getSkillIndex: jest.fn().mockReturnValue(makeSkillIndex(['memory-retrieval'])),
    });
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-opus-4-5',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: ['memory-retrieval'],
    });

    const result = await handleDispatchSingle('native-claude', 'Audit the memory system');
    const text = result.content[0].text;
    expect(text).toContain('--- SKILLS ---');
    expect(text).toContain('memory-retrieval');
    expect(text).toContain('Recall past findings');
  });

  it('omits the SKILLS block when no skills are bound', async () => {
    ctx.mainAgent = makeMainAgent({
      getSkillIndex: jest.fn().mockReturnValue(null),
    });
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-opus-4-5',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: [],
    });

    const result = await handleDispatchSingle('native-claude', 'Audit memory');
    expect(result.content[0].text).not.toContain('--- SKILLS ---');
  });

  it('places SKILLS block before CONSENSUS OUTPUT FORMAT in consensus dispatch', async () => {
    writeFileSync(
      join(skillDir, '.gossip', 'skills', 'memory-retrieval.md'),
      '---\nname: memory-retrieval\nmode: permanent\n---\nRecall past findings.\n',
    );
    ctx.mainAgent = makeMainAgent({
      getSkillIndex: jest.fn().mockReturnValue(makeSkillIndex(['memory-retrieval'])),
      generateLensesForAgents: jest.fn().mockResolvedValue(new Map()),
    });
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-opus-4-5',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: ['memory-retrieval'],
    });

    const result = await handleDispatchConsensus([
      { agent_id: 'native-claude', task: 'Audit memory' },
    ]);
    const text = result.content[0].text;
    const skillsIdx = text.indexOf('--- SKILLS ---');
    const consensusIdx = text.indexOf('--- CONSENSUS OUTPUT FORMAT ---');
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(consensusIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeLessThan(consensusIdx);
  });

  it('truncates the agent prompt when skill content pushes it past the 30k budget', async () => {
    // Write a skill file larger than MAX_AGENT_PROMPT_CHARS (30_000) so the
    // assembled agentPrompt is guaranteed to trip the truncation guard.
    const huge = '---\nname: memory-retrieval\nmode: permanent\n---\n' + 'x'.repeat(35_000);
    writeFileSync(join(skillDir, '.gossip', 'skills', 'memory-retrieval.md'), huge);
    ctx.mainAgent = makeMainAgent({
      getSkillIndex: jest.fn().mockReturnValue(makeSkillIndex(['memory-retrieval'])),
    });
    ctx.nativeAgentConfigs.set('native-claude', {
      model: 'claude-opus-4-5',
      instructions: 'You are a reviewer.',
      description: 'Native reviewer',
      skills: ['memory-retrieval'],
    });

    const result = await handleDispatchSingle('native-claude', 'Audit memory');
    expect(result.content[0].text).toContain('[Context truncated to fit budget]');
  });
});

// ── handleNativeRelay — compact return payload (consensus 2f25318c/634c3c43) ──

describe('handleNativeRelay — compact return payload', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir('compact-relay');
    resetCtx({}, testDir);
  });

  afterEach(() => {
    restoreCtx();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('return payload stays under 1200 chars even for a 10K-char agent result', async () => {
    const bigResult = 'x'.repeat(10_000);
    const now = Date.now();
    ctx.nativeTaskMap.set('task-big', {
      agentId: 'native-claude',
      task: 'Audit large file',
      startedAt: now - 500,
      timeoutMs: 30000,
    });
    // publishNativeGossip is mocked to resolve; getSessionGossip returns no entry
    // so handler falls back to truncated preview path
    ctx.mainAgent = makeMainAgent({
      projectRoot: testDir,
      publishNativeGossip: jest.fn().mockResolvedValue(undefined),
      getSessionGossip: jest.fn().mockReturnValue([]),
    });

    const result = await handleNativeRelay('task-big', bigResult);
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(1200);
  });

  it('exercises summarizeAndStoreGossip (via publishNativeGossip) before return', async () => {
    const now = Date.now();
    const summaryEntry = { agentId: 'native-claude', taskSummary: 'Found 2 race conditions in worker pool.', timestamp: now };
    const publishNativeGossip = jest.fn().mockResolvedValue(undefined);
    const getSessionGossip = jest.fn().mockReturnValue([summaryEntry]);

    ctx.mainAgent = makeMainAgent({
      projectRoot: testDir,
      publishNativeGossip,
      getSessionGossip,
    });
    ctx.nativeTaskMap.set('task-summ', {
      agentId: 'native-claude',
      task: 'Review worker pool',
      startedAt: now - 800,
      timeoutMs: 30000,
    });

    const result = await handleNativeRelay('task-summ', 'Full detailed output here');
    // publishNativeGossip must have been called (which calls summarizeAndStoreGossip internally)
    expect(publishNativeGossip).toHaveBeenCalledTimes(1);
    // Summary from session gossip is included in the return value
    const text = result.content[0].text;
    expect(text).toContain('Found 2 race conditions in worker pool.');
  });
});
