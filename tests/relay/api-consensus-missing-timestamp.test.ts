/**
 * Regression tests for issue #547 server-side vector:
 * /consensus 500s when a qualifying run's first signal has no timestamp field.
 *
 * Root cause (a3a35da1-060d4a81:f1): the pre-fix code set run.timestamp from
 * taskSignals[0].timestamp unconditionally, then called b.timestamp.localeCompare()
 * at sort time. A torn/partial JSONL write where the first signal lacks a
 * timestamp field produced undefined, causing localeCompare to throw TypeError.
 *
 * Fix: derive run timestamp as the first signal WITH a string timestamp (fail-open
 * to '' so the run sorts last but the endpoint returns 200 with the other runs).
 */

import { consensusHandler } from '@gossip/relay/dashboard/api-consensus';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-test-cts-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  return root;
}

describe('consensusHandler — missing timestamp on run first signal', () => {
  it('returns 200-shaped data when the first signal of a run has no timestamp', async () => {
    const root = makeTmpRoot();

    // Run 1 (good): 3 signals, 2 agents, all with timestamps — should appear in results
    const run1: object[] = [
      { type: 'consensus', taskId: 't1', consensusId: 'run1-aaa', signal: 'agreement', agentId: 'agent-a', counterpartId: 'agent-b', timestamp: '2026-06-11T10:00:00Z' },
      { type: 'consensus', taskId: 't1', consensusId: 'run1-aaa', signal: 'agreement', agentId: 'agent-b', counterpartId: 'agent-a', timestamp: '2026-06-11T10:01:00Z' },
      { type: 'consensus', taskId: 't1', consensusId: 'run1-aaa', signal: 'unique_confirmed', agentId: 'agent-a', counterpartId: 'agent-b', timestamp: '2026-06-11T10:02:00Z' },
    ];

    // Run 2 (torn): first signal has NO timestamp — this is the repro shape from the bug.
    // Second and third signals have timestamps so the run still qualifies (≥2 agents, ≥3 signals).
    const run2: object[] = [
      { type: 'consensus', taskId: 't2', consensusId: 'run2-bbb', signal: 'agreement', agentId: 'agent-c', counterpartId: 'agent-d' /* no timestamp */ },
      { type: 'consensus', taskId: 't2', consensusId: 'run2-bbb', signal: 'agreement', agentId: 'agent-d', counterpartId: 'agent-c', timestamp: '2026-06-11T09:00:00Z' },
      { type: 'consensus', taskId: 't2', consensusId: 'run2-bbb', signal: 'unique_confirmed', agentId: 'agent-c', counterpartId: 'agent-d', timestamp: '2026-06-11T09:01:00Z' },
    ];

    writeFileSync(
      join(root, '.gossip', 'agent-performance.jsonl'),
      [...run1, ...run2].map(r => JSON.stringify(r)).join('\n') + '\n',
    );

    // Must NOT throw — this was the TypeError before the fix
    const res = await consensusHandler(root);

    // Both qualifying runs must be present
    expect(res.runs).toHaveLength(2);
    expect(res.runs.map(r => r.taskId)).toContain('run1-aaa');
    expect(res.runs.map(r => r.taskId)).toContain('run2-bbb');

    // The torn run falls back to '' for its timestamp — it sorts last (empty < '2026...')
    const run1Result = res.runs.find(r => r.taskId === 'run1-aaa');
    const run2Result = res.runs.find(r => r.taskId === 'run2-bbb');
    expect(run1Result?.timestamp).toBe('2026-06-11T10:00:00Z');
    // Torn run picks the FIRST signal that has a valid timestamp (second signal)
    expect(run2Result?.timestamp).toBe('2026-06-11T09:00:00Z');

    // Run with full timestamps sorts before the torn run (most-recent-first)
    expect(res.runs[0].taskId).toBe('run1-aaa');
    expect(res.runs[1].taskId).toBe('run2-bbb');
  });

  it('handles a run where ALL signals have no timestamp — sorts last, does not throw', async () => {
    const root = makeTmpRoot();

    // A fully-torn run where no signal has a timestamp
    const tornRun: object[] = [
      { type: 'consensus', taskId: 'torn', consensusId: 'torn-ccc', signal: 'agreement', agentId: 'agent-x', counterpartId: 'agent-y' },
      { type: 'consensus', taskId: 'torn', consensusId: 'torn-ccc', signal: 'agreement', agentId: 'agent-y', counterpartId: 'agent-x' },
      { type: 'consensus', taskId: 'torn', consensusId: 'torn-ccc', signal: 'unique_confirmed', agentId: 'agent-x', counterpartId: 'agent-y' },
    ];

    // A good run that should sort first
    const goodRun: object[] = [
      { type: 'consensus', taskId: 'good', consensusId: 'good-ddd', signal: 'agreement', agentId: 'agent-a', counterpartId: 'agent-b', timestamp: '2026-06-11T08:00:00Z' },
      { type: 'consensus', taskId: 'good', consensusId: 'good-ddd', signal: 'agreement', agentId: 'agent-b', counterpartId: 'agent-a', timestamp: '2026-06-11T08:01:00Z' },
      { type: 'consensus', taskId: 'good', consensusId: 'good-ddd', signal: 'unique_confirmed', agentId: 'agent-a', counterpartId: 'agent-b', timestamp: '2026-06-11T08:02:00Z' },
    ];

    writeFileSync(
      join(root, '.gossip', 'agent-performance.jsonl'),
      [...tornRun, ...goodRun].map(r => JSON.stringify(r)).join('\n') + '\n',
    );

    const res = await consensusHandler(root);
    expect(res.runs).toHaveLength(2);

    const tornResult = res.runs.find(r => r.taskId === 'torn-ccc');
    expect(tornResult?.timestamp).toBe(''); // defensive fallback

    // Good run sorts before torn run (non-empty > empty in localeCompare)
    expect(res.runs[0].taskId).toBe('good-ddd');
    expect(res.runs[1].taskId).toBe('torn-ccc');
  });
});
