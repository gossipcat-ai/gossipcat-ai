/**
 * Tests for taskDetailHandler (packages/relay/src/dashboard/api-task-detail.ts).
 *
 * Uses a tmp fixture directory with synthetic task-graph.jsonl,
 * agent-performance.jsonl, and implementation-findings.jsonl files.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { taskDetailHandler } from '../../packages/relay/src/dashboard/api-task-detail';

// ─── fixture helpers ────────────────────────────────────────────────────────

function writeLines(path: string, lines: object[]) {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('taskDetailHandler', () => {
  let dir: string;
  let gossipDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gossip-task-detail-test-'));
    gossipDir = join(dir, '.gossip');
    mkdirSync(gossipDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when task-graph.jsonl does not exist', async () => {
    const result = await taskDetailHandler(dir, 'nonexistent-id');
    expect(result).toBeNull();
  });

  it('returns null when taskId is not in task-graph.jsonl', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-a', agentId: 'sonnet-implementer', task: 'Do A', timestamp: '2026-06-01T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-a', durationMs: 5000, timestamp: '2026-06-01T00:00:05.000Z' },
    ]);
    const result = await taskDetailHandler(dir, 'task-does-not-exist');
    expect(result).toBeNull();
  });

  it('returns basic task data for a completed task', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-b', agentId: 'haiku-researcher', task: 'Research B', timestamp: '2026-06-01T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-b', durationMs: 12000, result: 'done', timestamp: '2026-06-01T00:00:12.000Z' },
    ]);
    const result = await taskDetailHandler(dir, 'task-b');
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('task-b');
    expect(result!.agentId).toBe('haiku-researcher');
    expect(result!.status).toBe('completed');
    expect(result!.duration).toBe(12000);
    expect(result!.result).toBe('done');
  });

  it('returns createdAt as the dispatch (task.created) timestamp', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-b2', agentId: 'haiku-researcher', task: 'Research B2', timestamp: '2026-06-01T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-b2', durationMs: 12000, result: 'done', timestamp: '2026-06-01T00:00:12.000Z' },
    ]);
    const result = await taskDetailHandler(dir, 'task-b2');
    expect(result).not.toBeNull();
    // createdAt = task.created timestamp
    expect(result!.createdAt).toBe('2026-06-01T00:00:00.000Z');
    // timestamp = task.completed timestamp (completion time, not dispatch time)
    expect(result!.timestamp).toBe('2026-06-01T00:00:12.000Z');
  });

  it('resolves task beyond 2000 rows by reading task-graph directly', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    // Write 2001 tasks; the target task is last
    const lines: object[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push({ type: 'task.created', taskId: `filler-${i}`, agentId: 'sonnet-implementer', task: `Task ${i}`, timestamp: '2026-06-01T00:00:00.000Z' });
      lines.push({ type: 'task.completed', taskId: `filler-${i}`, durationMs: 1000, timestamp: '2026-06-01T00:00:01.000Z' });
    }
    lines.push({ type: 'task.created', taskId: 'task-deep', agentId: 'gemini-reviewer', task: 'Deep task', timestamp: '2026-05-01T00:00:00.000Z' });
    lines.push({ type: 'task.completed', taskId: 'task-deep', durationMs: 5000, timestamp: '2026-05-01T00:00:05.000Z' });
    writeLines(graphPath, lines);
    const result = await taskDetailHandler(dir, 'task-deep');
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('task-deep');
    expect(result!.agentId).toBe('gemini-reviewer');
  });

  it('resolves utility-agent tasks (not filtered out)', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'util-task-1', agentId: '_utility', task: 'Utility work', timestamp: '2026-06-01T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'util-task-1', durationMs: 100, timestamp: '2026-06-01T00:00:00.100Z' },
    ]);
    const result = await taskDetailHandler(dir, 'util-task-1');
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('util-task-1');
    expect(result!.agentId).toBe('_utility');
  });

  it('enriches with signalCount and consensusId from agent-performance.jsonl (single pass)', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-c', agentId: 'sonnet-reviewer', task: 'Review C', timestamp: '2026-06-02T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-c', durationMs: 3000, timestamp: '2026-06-02T00:00:03.000Z' },
    ]);

    const perfPath = join(gossipDir, 'agent-performance.jsonl');
    writeLines(perfPath, [
      { type: 'consensus', signal: 'agreement', taskId: 'task-c', agentId: 'sonnet-reviewer', consensusId: 'aaaa0000-bbbb1111', timestamp: '2026-06-02T00:00:04.000Z' },
      { type: 'consensus', signal: 'unique_confirmed', taskId: 'task-c', agentId: 'sonnet-reviewer', consensusId: 'aaaa0000-bbbb1111', timestamp: '2026-06-02T00:00:05.000Z' },
      // Different task — should not be counted
      { type: 'consensus', signal: 'agreement', taskId: 'other-task', agentId: 'sonnet-reviewer', consensusId: 'aaaa0000-bbbb1111', timestamp: '2026-06-02T00:00:06.000Z' },
    ]);

    const result = await taskDetailHandler(dir, 'task-c');
    expect(result).not.toBeNull();
    expect(result!.signalCount).toBe(2);
    expect(result!.consensusId).toBe('aaaa0000-bbbb1111');
  });

  it('collects siblingTaskIds from other tasks sharing the same consensusId', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-d', agentId: 'gemini-reviewer', task: 'Review D', timestamp: '2026-06-03T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-d', durationMs: 2000, timestamp: '2026-06-03T00:00:02.000Z' },
    ]);

    const perfPath = join(gossipDir, 'agent-performance.jsonl');
    writeLines(perfPath, [
      { type: 'consensus', signal: 'agreement', taskId: 'task-d', agentId: 'gemini-reviewer', consensusId: 'cccc2222-dddd3333', timestamp: '2026-06-03T00:00:03.000Z' },
      // Sibling tasks in same consensus round
      { type: 'consensus', signal: 'agreement', taskId: 'task-sib1', agentId: 'sonnet-reviewer', consensusId: 'cccc2222-dddd3333', timestamp: '2026-06-03T00:00:03.000Z' },
      { type: 'consensus', signal: 'agreement', taskId: 'task-sib2', agentId: 'haiku-researcher', consensusId: 'cccc2222-dddd3333', timestamp: '2026-06-03T00:00:04.000Z' },
      // Different consensus round — should NOT be a sibling
      { type: 'consensus', signal: 'agreement', taskId: 'task-other', agentId: 'haiku-researcher', consensusId: 'eeee4444-ffff5555', timestamp: '2026-06-03T00:00:05.000Z' },
    ]);

    const result = await taskDetailHandler(dir, 'task-d');
    expect(result).not.toBeNull();
    expect(result!.siblingTaskIds).toBeDefined();
    expect(result!.siblingTaskIds).toHaveLength(2);
    expect(result!.siblingTaskIds).toContain('task-sib1');
    expect(result!.siblingTaskIds).toContain('task-sib2');
    expect(result!.siblingTaskIds).not.toContain('task-d');
    expect(result!.siblingTaskIds).not.toContain('task-other');
  });

  it('sets siblingsTruncated=true when sibling cap is hit', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-cap', agentId: 'sonnet-reviewer', task: 'Cap test', timestamp: '2026-06-03T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-cap', durationMs: 1000, timestamp: '2026-06-03T00:00:01.000Z' },
    ]);

    const perfPath = join(gossipDir, 'agent-performance.jsonl');
    // Write 26 sibling entries (cap is 25) + 1 for the main task
    const lines: object[] = [
      { type: 'consensus', signal: 'agreement', taskId: 'task-cap', agentId: 'sonnet-reviewer', consensusId: 'cap-round-id', timestamp: '2026-06-03T00:00:02.000Z' },
    ];
    for (let i = 0; i < 26; i++) {
      lines.push({ type: 'consensus', signal: 'agreement', taskId: `sib-${i}`, agentId: 'sonnet-reviewer', consensusId: 'cap-round-id', timestamp: '2026-06-03T00:00:02.000Z' });
    }
    writeLines(perfPath, lines);

    const result = await taskDetailHandler(dir, 'task-cap');
    expect(result).not.toBeNull();
    expect(result!.siblingTaskIds).toHaveLength(25);
    expect(result!.siblingsTruncated).toBe(true);
  });

  it('counts findingCount by consensusId prefix (not exact match)', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-findings', agentId: 'gemini-reviewer', task: 'Review', timestamp: '2026-06-04T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-findings', durationMs: 3000, timestamp: '2026-06-04T00:00:03.000Z' },
    ]);

    const perfPath = join(gossipDir, 'agent-performance.jsonl');
    writeLines(perfPath, [
      { type: 'consensus', signal: 'agreement', taskId: 'task-findings', agentId: 'gemini-reviewer', consensusId: 'round-abc123', timestamp: '2026-06-04T00:00:04.000Z' },
    ]);

    const findingsPath = join(gossipDir, 'implementation-findings.jsonl');
    writeLines(findingsPath, [
      // These match the consensusId prefix
      { taskId: 'round-abc123:f1', originalAgentId: 'gemini-reviewer', finding: 'bug A', tag: 'confirmed' },
      { taskId: 'round-abc123:f2', originalAgentId: 'sonnet-reviewer', finding: 'bug B', tag: 'unique' },
      // Different consensus round — should NOT be counted
      { taskId: 'round-other:f1', originalAgentId: 'haiku-researcher', finding: 'bug C', tag: 'confirmed' },
      // Exact task dispatch ID — also should NOT be counted (not the prefix format)
      { taskId: 'task-findings', originalAgentId: 'gemini-reviewer', finding: 'bug D', tag: 'confirmed' },
    ]);

    const result = await taskDetailHandler(dir, 'task-findings');
    expect(result).not.toBeNull();
    expect(result!.consensusId).toBe('round-abc123');
    // Only the two rows starting with "round-abc123:" should be counted
    expect(result!.findingCount).toBe(2);
  });

  it('returns findingCount=0 when no consensusId (no findings lookup)', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-e', agentId: 'sonnet-implementer', task: 'Implement E', timestamp: '2026-06-04T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-e', durationMs: 8000, timestamp: '2026-06-04T00:00:08.000Z' },
    ]);

    const findingsPath = join(gossipDir, 'implementation-findings.jsonl');
    writeLines(findingsPath, [
      { taskId: 'some-consensus-id:f1', originalAgentId: 'gemini-reviewer', finding: 'bug', tag: 'confirmed' },
    ]);

    const result = await taskDetailHandler(dir, 'task-e');
    expect(result).not.toBeNull();
    // No consensusId → findingCount stays 0, no prefix lookup
    expect(result!.findingCount).toBe(0);
    expect(result!.consensusId).toBeUndefined();
  });

  it('gracefully handles missing agent-performance.jsonl (no enrichment fields)', async () => {
    const graphPath = join(gossipDir, 'task-graph.jsonl');
    writeLines(graphPath, [
      { type: 'task.created', taskId: 'task-f', agentId: 'deepseek-challenger', task: 'Challenge F', timestamp: '2026-06-05T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-f', durationMs: 1000, timestamp: '2026-06-05T00:00:01.000Z' },
    ]);

    // No agent-performance.jsonl written
    const result = await taskDetailHandler(dir, 'task-f');
    expect(result).not.toBeNull();
    expect(result!.signalCount).toBe(0);
    expect(result!.consensusId).toBeUndefined();
    expect(result!.siblingTaskIds).toBeUndefined();
    expect(result!.siblingsTruncated).toBeUndefined();
  });
});
