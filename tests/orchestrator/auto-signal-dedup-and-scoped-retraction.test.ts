/**
 * Tests for audit 6eed37aa-dfba43ca f9 (append-time auto-signal dedup) plus the
 * orchestrator-discovered late-relay self-voiding retraction bug.
 *
 * FIX A — late-relay scoped retraction:
 *   apps/cli/src/handlers/native-tasks.ts emits a `signal_retracted` tombstone
 *   when a late relay overwrites a timed_out result. Previously the tombstone
 *   carried no `retractedSignal`, so the reader treated it as a WILDCARD and
 *   voided every consensus signal for that agent+task — not just task_timeout.
 *   The fix scopes the tombstone to `retractedSignal: 'task_timeout'`.
 *
 * FIX B — append-time dedup:
 *   emitCompletionSignals (completion-signals.ts) and emitImplSignals
 *   (signal-helpers.ts) re-run their full emission on a crash/retry between the
 *   signal append and nativeTaskMap.delete(task_id), double-counting the same
 *   task. dedupeOncePerTaskSignals (auto-signal-dedup.ts) skips any
 *   (agentId, taskId, signal) triple already on disk.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  emitCompletionSignals,
  emitImplSignals,
  emitConsensusSignals,
  PerformanceReader,
} from '@gossip/orchestrator';
import { __resetWarnRateLimiterForTests } from '../../packages/orchestrator/src/performance-reader';
import type { ConsensusSignal } from '../../packages/orchestrator/src/consensus-types';

const JSONL = '.gossip/agent-performance.jsonl';

function readRows(dir: string): any[] {
  const p = path.join(dir, JSONL);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    // Drop round-counter bump meta-records — only signal rows matter here.
    .filter(r => r && typeof r.signal === 'string' && typeof r.agentId === 'string');
}

const tmpDirs: string[] = [];

function makeTmpDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gossip-${label}-`));
  fs.mkdirSync(path.join(dir, '.gossip'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // The dedup read path goes through parseJsonlLines, whose torn-line warn
  // rate-limiter is module-level state — reset like the sibling suites do.
  __resetWarnRateLimiterForTests();
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// FIX A — scoped late-relay retraction (reader-side semantics, writer-side fix)
// ──────────────────────────────────────────────────────────────────────────
describe('FIX A — late-relay scoped retraction', () => {
  function makeConsensus(over: Partial<ConsensusSignal>): ConsensusSignal {
    return {
      type: 'consensus',
      taskId: 'late-task',
      signal: 'task_timeout',
      agentId: 'late-agent',
      timestamp: new Date().toISOString(),
      evidence: '',
      ...over,
    } as ConsensusSignal;
  }

  it('scoped retraction voids ONLY task_timeout, leaving other consensus signals for the same agent+task intact', () => {
    const reader = new PerformanceReader('');
    // The late-relay flow: a timeout signal, then a SCOPED retraction, then the
    // agent ALSO has a legitimate consensus signal under the same task id.
    const signals: ConsensusSignal[] = [
      makeConsensus({ signal: 'task_timeout', taskId: 'late-task' }),
      makeConsensus({ signal: 'agreement', category: 'concurrency', taskId: 'late-task' }),
      makeConsensus({
        signal: 'signal_retracted',
        taskId: 'late-task',
        retractedSignal: 'task_timeout', // ← the fix
      }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('late-agent');
    expect(score).toBeDefined();
    // task_timeout retracted → does not count. agreement survives → 1 scoring signal.
    expect(score.totalSignals).toBe(1);
    expect(score.agreements).toBe(1);
  });

  it('UNSCOPED (legacy) retraction still voids ALL consensus signals for that agent+task — back-compat preserved', () => {
    const reader = new PerformanceReader('');
    const signals: ConsensusSignal[] = [
      makeConsensus({ signal: 'task_timeout', taskId: 'legacy-task' }),
      makeConsensus({ signal: 'agreement', category: 'concurrency', taskId: 'legacy-task' }),
      makeConsensus({
        signal: 'signal_retracted',
        taskId: 'legacy-task',
        // no retractedSignal → wildcard, the historical behaviour
      }),
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('late-agent');
    // Wildcard voids both task_timeout AND agreement for this agent+task.
    expect(score?.totalSignals ?? 0).toBe(0);
  });

  it('a different agent+task is unaffected by an unscoped retraction (no cross-task leakage)', () => {
    const reader = new PerformanceReader('');
    const signals: ConsensusSignal[] = [
      makeConsensus({ signal: 'agreement', category: 'concurrency', taskId: 'other-task' }),
      makeConsensus({ signal: 'signal_retracted', taskId: 'legacy-task' }), // wildcard, different task
    ];
    const scores = (reader as any).computeScores(signals);
    const score = scores.get('late-agent');
    // The retraction is keyed to legacy-task; other-task's agreement survives.
    expect(score.totalSignals).toBe(1);
    expect(score.agreements).toBe(1);
  });

  it('end-to-end on disk: task_timeout + scoped retraction + re-emitted impl_test_pass → timeout excluded, impl counted exactly once', () => {
    const dir = makeTmpDir('fixA-e2e');
    // Timeout fires (consensus).
    emitConsensusSignals(dir, [{
      type: 'consensus',
      signal: 'task_timeout',
      agentId: 'late-agent',
      taskId: 'late-task',
      evidence: 'timed out',
      timestamp: new Date().toISOString(),
    }]);
    // Late relay arrives → scoped retraction of task_timeout.
    emitConsensusSignals(dir, [{
      type: 'consensus',
      signal: 'signal_retracted',
      agentId: 'late-agent',
      taskId: 'late-task',
      retractedSignal: 'task_timeout',
      evidence: 'late relay',
      timestamp: new Date().toISOString(),
    }]);
    // Re-emitted auto-signals (FIRST emission for these triples → not deduped).
    emitImplSignals(dir, [{
      type: 'impl',
      signal: 'impl_test_pass',
      agentId: 'late-agent',
      taskId: 'late-task',
      source: 'auto',
      timestamp: new Date().toISOString(),
    }]);
    emitCompletionSignals(dir, {
      agentId: 'late-agent',
      taskId: 'late-task',
      result: '<agent_finding type="finding" severity="low">ok</agent_finding>',
      elapsedMs: 1000,
    });

    const rows = readRows(dir);
    // The on-disk timeout row + the impl_test_pass row both physically exist...
    expect(rows.some(r => r.signal === 'task_timeout')).toBe(true);
    expect(rows.filter(r => r.signal === 'impl_test_pass')).toHaveLength(1);
    expect(rows.filter(r => r.signal === 'task_completed')).toHaveLength(1);

    // ...but the reader excludes the retracted timeout and counts the impl pass.
    // getImplScore reflects exactly one pass and zero fails (passRate === 1).
    const reader = new PerformanceReader(dir);
    const impl = reader.getImplScore('late-agent');
    expect(impl).not.toBeNull();
    expect(impl!.passRate).toBe(1);

    // And the scoring path (computeScores via getScores) excludes the retracted
    // task_timeout consensus signal: late-agent has no surviving consensus
    // scoring signal, so getScores yields no penalising timeout entry.
    const scores = reader.getScores();
    // Unconditional (consensus f7d8b67a f15/f20 follow-up): an acc entry DOES
    // exist for late-agent (execution disproved the round's "unreachable
    // branch" claim — the impl task seeds an entry), so assert the retraction
    // semantics directly: zero surviving consensus signals, and specifically
    // no timeout-derived penalty rows.
    const late = scores.get('late-agent');
    expect(late?.totalSignals ?? 0).toBe(0);
    expect(late?.disagreements ?? 0).toBe(0);
    expect(late?.hallucinations ?? 0).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// FIX B — append-time dedup for once-per-task auto-signals
// ──────────────────────────────────────────────────────────────────────────
describe('FIX B — emitCompletionSignals append-time dedup', () => {
  it('calling emitCompletionSignals twice for the same task appends only one set', () => {
    const dir = makeTmpDir('fixB-completion');
    const input = {
      agentId: 'agent-b',
      taskId: 'task-dup',
      result: 'plain result with no findings',
      elapsedMs: 2000,
    };
    emitCompletionSignals(dir, input);
    const firstCount = readRows(dir).length;
    expect(firstCount).toBeGreaterThan(0);

    // Second call — the crash/retry scenario. Should be fully deduped.
    emitCompletionSignals(dir, input);
    const secondRows = readRows(dir);

    expect(secondRows.filter(r => r.signal === 'task_completed')).toHaveLength(1);
    expect(secondRows.filter(r => r.signal === 'format_compliance')).toHaveLength(1);
    // No new signal rows after the second call.
    expect(secondRows.length).toBe(firstCount);
  });

  it('a distinct task is NOT blocked by another task\'s prior emission', () => {
    const dir = makeTmpDir('fixB-distinct');
    emitCompletionSignals(dir, { agentId: 'agent-b', taskId: 'task-1', result: 'x', elapsedMs: 1 });
    emitCompletionSignals(dir, { agentId: 'agent-b', taskId: 'task-2', result: 'x', elapsedMs: 1 });
    const rows = readRows(dir);
    expect(rows.filter(r => r.signal === 'task_completed' && r.taskId === 'task-1')).toHaveLength(1);
    expect(rows.filter(r => r.signal === 'task_completed' && r.taskId === 'task-2')).toHaveLength(1);
  });
});

describe('FIX B — emitImplSignals append-time dedup', () => {
  it('calling emitImplSignals twice for the same task appends only one impl signal', () => {
    const dir = makeTmpDir('fixB-impl');
    const sig = {
      type: 'impl' as const,
      signal: 'impl_test_pass' as const,
      agentId: 'agent-b',
      taskId: 'impl-dup',
      source: 'auto' as const,
      timestamp: new Date().toISOString(),
    };
    emitImplSignals(dir, [sig]);
    emitImplSignals(dir, [{ ...sig, timestamp: new Date(Date.now() + 5).toISOString() }]);

    const rows = readRows(dir);
    expect(rows.filter(r => r.signal === 'impl_test_pass')).toHaveLength(1);
  });

  it('impl_test_fail for the same task+agent is a distinct triple and is NOT deduped against impl_test_pass', () => {
    const dir = makeTmpDir('fixB-impl-distinct-signal');
    emitImplSignals(dir, [{
      type: 'impl', signal: 'impl_test_pass', agentId: 'agent-b', taskId: 'impl-x',
      source: 'auto', timestamp: new Date().toISOString(),
    }]);
    emitImplSignals(dir, [{
      type: 'impl', signal: 'impl_test_fail', agentId: 'agent-b', taskId: 'impl-x',
      source: 'auto', timestamp: new Date().toISOString(),
    }]);
    const rows = readRows(dir);
    expect(rows.filter(r => r.signal === 'impl_test_pass')).toHaveLength(1);
    expect(rows.filter(r => r.signal === 'impl_test_fail')).toHaveLength(1);
  });

  it('collapses a self-duplicated batch (same triple twice in one call) to a single write', () => {
    const dir = makeTmpDir('fixB-impl-batch');
    const sig = {
      type: 'impl' as const,
      signal: 'impl_test_pass' as const,
      agentId: 'agent-b',
      taskId: 'impl-batch',
      source: 'auto' as const,
      timestamp: new Date().toISOString(),
    };
    emitImplSignals(dir, [sig, { ...sig }]);
    const rows = readRows(dir);
    expect(rows.filter(r => r.signal === 'impl_test_pass')).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// FIX A × FIX B interaction — dedup must NOT block the late-relay re-emission
// ──────────────────────────────────────────────────────────────────────────
describe('FIX A × FIX B — dedup does not block late-relay re-emission', () => {
  it('after a prior task_timeout + scoped retraction, the re-emitted impl/completion signals are FIRST emissions and land', () => {
    const dir = makeTmpDir('fixAB-interaction');
    // Timeout path emits ONLY task_timeout (no impl/completion signals).
    emitConsensusSignals(dir, [{
      type: 'consensus',
      signal: 'task_timeout',
      agentId: 'late-agent',
      taskId: 'late-task',
      evidence: 'timed out',
      timestamp: new Date().toISOString(),
    }]);
    emitConsensusSignals(dir, [{
      type: 'consensus',
      signal: 'signal_retracted',
      agentId: 'late-agent',
      taskId: 'late-task',
      retractedSignal: 'task_timeout',
      evidence: 'late relay',
      timestamp: new Date().toISOString(),
    }]);

    // The late relay now emits the once-per-task auto-signals for the FIRST time
    // for these (agentId, taskId, signal) triples — dedup must let them through.
    emitImplSignals(dir, [{
      type: 'impl', signal: 'impl_test_pass', agentId: 'late-agent', taskId: 'late-task',
      source: 'auto', timestamp: new Date().toISOString(),
    }]);
    emitCompletionSignals(dir, {
      agentId: 'late-agent', taskId: 'late-task', result: 'done', elapsedMs: 1500,
    });

    const rows = readRows(dir);
    expect(rows.filter(r => r.signal === 'impl_test_pass')).toHaveLength(1);
    expect(rows.filter(r => r.signal === 'task_completed')).toHaveLength(1);
  });
});
