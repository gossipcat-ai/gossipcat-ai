import { overviewHandler } from '@gossip/relay/dashboard/api-overview';
import { agentsHandler } from '@gossip/relay/dashboard/api-agents';
import { skillsGetHandler, skillsBindHandler } from '@gossip/relay/dashboard/api-skills';
import { memoryHandler } from '@gossip/relay/dashboard/api-memory';
import { tasksHandler } from '@gossip/relay/dashboard/api-tasks';
import { signalsHandler } from '@gossip/relay/dashboard/api-signals';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Overview API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('returns zero counts for fresh project', async () => {
    const result = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
    expect(result).toEqual({
      agentsOnline: 0, relayCount: 0, relayConnected: 0, nativeCount: 0,
      consensusRuns: 0, totalFindings: 0, confirmedFindings: 0, totalSignals: 0,
      tasksCompleted: 0, tasksFailed: 0, avgDurationMs: 0,
      lastConsensusTimestamp: '', actionableFindings: 0,
    });
  });

  it('counts agents by type', async () => {
    const configs = [
      { id: 'a', provider: 'anthropic', model: 'm', skills: [], native: true },
      { id: 'b', provider: 'google', model: 'm', skills: [] },
      { id: 'c', provider: 'google', model: 'm', skills: [] },
    ];
    const result = await overviewHandler(projectRoot, { agentConfigs: configs as any, relayConnections: 2, connectedAgentIds: [] });
    expect(result.agentsOnline).toBe(1); // connectedAgentIds(0) + nativeCount(1)
    expect(result.nativeCount).toBe(1);
    expect(result.relayCount).toBe(2);
  });

  it('counts signals from agent-performance.jsonl', async () => {
    const signals = [
      { type: 'consensus', signal: 'agreement', agentId: 'a', evidence: 'x', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'agreement', agentId: 'b', evidence: 'y', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'a', evidence: 'z', timestamp: new Date().toISOString() },
    ];
    writeFileSync(
      join(projectRoot, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    );
    const result = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
    expect(result.totalSignals).toBe(3);
  });
});

describe('Agents API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('returns agent configs with default scores for fresh project', async () => {
    const configs = [
      { id: 'sonnet-reviewer', provider: 'anthropic' as const, model: 'claude-sonnet-4-6', preset: 'reviewer', skills: ['code_review'], native: true },
    ];
    const result = await agentsHandler(projectRoot, configs);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('sonnet-reviewer');
    expect(result[0].native).toBe(true);
    expect(result[0].scores.accuracy).toBe(0.5);
  });

  it('reads real scores from agent-performance.jsonl', async () => {
    const configs = [
      { id: 'agent-a', provider: 'anthropic' as const, model: 'm', skills: [] },
    ];
    const signals = Array.from({ length: 5 }, () => ({
      type: 'consensus', signal: 'agreement', agentId: 'agent-a',
      evidence: 'x', timestamp: new Date().toISOString(),
    }));
    writeFileSync(
      join(projectRoot, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    );
    const result = await agentsHandler(projectRoot, configs);
    expect(result[0].scores.accuracy).toBeGreaterThan(0.5);
    expect(result[0].scores.agreements).toBe(5);
  });

  it('returns empty array when no agents configured', async () => {
    const result = await agentsHandler(projectRoot, []);
    expect(result).toEqual([]);
  });

  it('includes lastTask field from task-graph.jsonl', async () => {
    const configs = [{ id: 'agent-a', provider: 'anthropic' as const, model: 'm', skills: [] }];
    const tasks = [
      { type: 'task.created', taskId: 't1', agentId: 'agent-a', task: 'Review auth module', timestamp: '2026-03-29T14:00:00Z' },
      { type: 'task.completed', taskId: 't1', duration: 5000, timestamp: '2026-03-29T14:00:05Z', inputTokens: 1000, outputTokens: 500 },
    ];
    writeFileSync(join(projectRoot, '.gossip', 'task-graph.jsonl'), tasks.map(t => JSON.stringify(t)).join('\n') + '\n');
    const result = await agentsHandler(projectRoot, configs, []);
    expect(result[0].lastTask).toBeDefined();
    expect(result[0].lastTask!.task).toContain('Review auth');
    expect(result[0].totalTokens).toBe(1500);
  });

  it('includes online status from onlineAgents list', async () => {
    const configs = [
      { id: 'agent-a', provider: 'anthropic' as const, model: 'm', skills: [] },
      { id: 'agent-b', provider: 'google' as const, model: 'g', skills: [] },
    ];
    const result = await agentsHandler(projectRoot, configs, ['agent-a']);
    expect(result[0].online).toBe(true);
    expect(result[1].online).toBe(false);
  });

  it('totalTokens is 0 and lastTask is null when no task-graph.jsonl', async () => {
    const configs = [{ id: 'agent-a', provider: 'anthropic' as const, model: 'm', skills: [] }];
    const result = await agentsHandler(projectRoot, configs, []);
    expect(result[0].totalTokens).toBe(0);
    expect(result[0].lastTask).toBeNull();
    expect(result[0].online).toBe(false);
  });

  it('sums tokens across multiple tasks for the same agent', async () => {
    const configs = [{ id: 'agent-a', provider: 'anthropic' as const, model: 'm', skills: [] }];
    const tasks = [
      { type: 'task.created', taskId: 't1', agentId: 'agent-a', task: 'Task one', timestamp: '2026-03-29T13:00:00Z' },
      { type: 'task.completed', taskId: 't1', duration: 1000, timestamp: '2026-03-29T13:00:01Z', inputTokens: 200, outputTokens: 100 },
      { type: 'task.created', taskId: 't2', agentId: 'agent-a', task: 'Task two', timestamp: '2026-03-29T14:00:00Z' },
      { type: 'task.completed', taskId: 't2', duration: 2000, timestamp: '2026-03-29T14:00:02Z', inputTokens: 300, outputTokens: 150 },
    ];
    writeFileSync(join(projectRoot, '.gossip', 'task-graph.jsonl'), tasks.map(t => JSON.stringify(t)).join('\n') + '\n');
    const result = await agentsHandler(projectRoot, configs, []);
    expect(result[0].totalTokens).toBe(750);
    expect(result[0].lastTask!.task).toContain('Task two');
  });
});

describe('Skills API', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('returns empty index for fresh project', async () => {
    const result = await skillsGetHandler(projectRoot);
    expect(result.index).toEqual({});
    expect(result.suggestions).toEqual([]);
  });

  it('returns skill index data when populated', async () => {
    writeFileSync(join(projectRoot, '.gossip', 'skill-index.json'), JSON.stringify({
      'agent-a': { code_review: { skill: 'code_review', enabled: true, source: 'config', version: 1, boundAt: '2026-01-01' } }
    }));
    const result = await skillsGetHandler(projectRoot);
    expect(result.index['agent-a']).toBeDefined();
    expect(result.index['agent-a']['code_review'].enabled).toBe(true);
  });

  it('toggles skill enabled state', async () => {
    writeFileSync(join(projectRoot, '.gossip', 'skill-index.json'), JSON.stringify({
      'agent-a': { code_review: { skill: 'code_review', enabled: true, source: 'config', version: 1, boundAt: '2026-01-01' } }
    }));
    const result = await skillsBindHandler(projectRoot, { agent_id: 'agent-a', skill: 'code_review', enabled: false });
    expect(result.success).toBe(true);
    const updated = await skillsGetHandler(projectRoot);
    expect(updated.index['agent-a']['code_review'].enabled).toBe(false);
  });

  it('rejects invalid agent_id', async () => {
    const result = await skillsBindHandler(projectRoot, { agent_id: '../etc', skill: 'x', enabled: true });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('Memory API', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip', 'agents', 'agent-a', 'memory'), { recursive: true });
  });

  it('returns empty data for agent with no memory', async () => {
    const result = await memoryHandler(projectRoot, 'agent-a');
    expect(result.index).toBe('');
    expect(result.knowledge).toEqual([]);
    expect(result.tasks).toEqual([]);
  });

  it('reads MEMORY.md index', async () => {
    const memDir = join(projectRoot, '.gossip', 'agents', 'agent-a', 'memory');
    writeFileSync(join(memDir, 'MEMORY.md'), '# Agent A Memory\n- [Skill review](skill-review.md)');
    const result = await memoryHandler(projectRoot, 'agent-a');
    expect(result.index).toContain('Agent A Memory');
  });

  it('reads knowledge files with frontmatter', async () => {
    const memDir = join(projectRoot, '.gossip', 'agents', 'agent-a', 'memory');
    writeFileSync(join(memDir, 'MEMORY.md'), '');
    writeFileSync(join(memDir, 'review.md'), '---\nname: review\ndescription: code review notes\nimportance: 3\n---\nSome content');
    const result = await memoryHandler(projectRoot, 'agent-a');
    expect(result.knowledge).toHaveLength(1);
    expect(result.knowledge[0].filename).toBe('review.md');
    expect(result.knowledge[0].content).toContain('Some content');
  });

  it('reads tasks.jsonl', async () => {
    const memDir = join(projectRoot, '.gossip', 'agents', 'agent-a', 'memory');
    writeFileSync(join(memDir, 'MEMORY.md'), '');
    const task = { version: 1, taskId: 't1', task: 'review', skills: [], findings: 0, hallucinated: 0, scores: { relevance: 1, accuracy: 1, uniqueness: 0 }, warmth: 1, importance: 3, timestamp: '2026-01-01' };
    writeFileSync(join(memDir, 'tasks.jsonl'), JSON.stringify(task) + '\n');
    const result = await memoryHandler(projectRoot, 'agent-a');
    expect(result.tasks).toHaveLength(1);
    expect((result.tasks[0] as any).taskId).toBe('t1');
  });

  it('rejects path traversal in agentId', async () => {
    await expect(memoryHandler(projectRoot, '../../../etc/passwd')).rejects.toThrow('Invalid agent ID');
  });

  it('rejects prototype-polluting agent IDs', async () => {
    await expect(memoryHandler(projectRoot, '__proto__')).rejects.toThrow('Invalid agent ID');
  });

  it('returns fileCount and cognitiveCount', async () => {
    const memDir = join(projectRoot, '.gossip', 'agents', 'test-agent', 'memory', 'knowledge');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'regular.md'), '---\nname: test\ntype: knowledge\n---\nContent');
    writeFileSync(join(memDir, 'cognitive.md'), '---\nname: review\ntype: cognitive\n---\nYou reviewed the auth module');
    const result = await memoryHandler(projectRoot, 'test-agent');
    expect(result.fileCount).toBe(2);
    expect(result.cognitiveCount).toBe(1);
  });
});

describe('Tasks API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('exposes inputTokens and outputTokens per task', async () => {
    const events = [
      { type: 'task.created', taskId: 't1', agentId: 'a', task: 'Review', timestamp: '2026-03-29T14:00:00Z' },
      { type: 'task.completed', taskId: 't1', duration: 5000, timestamp: '2026-03-29T14:00:05Z', inputTokens: 2000, outputTokens: 800 },
    ];
    writeFileSync(join(projectRoot, '.gossip', 'task-graph.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const result = await tasksHandler(projectRoot);
    expect(result.items[0].inputTokens).toBe(2000);
    expect(result.items[0].outputTokens).toBe(800);
  });

  it('returns undefined token fields when not present in completed event', async () => {
    const events = [
      { type: 'task.created', taskId: 't2', agentId: 'b', task: 'Implement', timestamp: '2026-03-29T15:00:00Z' },
      { type: 'task.completed', taskId: 't2', duration: 3000, timestamp: '2026-03-29T15:00:03Z' },
    ];
    writeFileSync(join(projectRoot, '.gossip', 'task-graph.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const result = await tasksHandler(projectRoot);
    expect(result.items[0].inputTokens).toBeUndefined();
    expect(result.items[0].outputTokens).toBeUndefined();
  });

  it('returns empty tasks for fresh project', async () => {
    const result = await tasksHandler(projectRoot);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe('Signals API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('returns empty array when no performance file', async () => {
    const result = await signalsHandler(projectRoot, undefined);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns consensus signals sorted by time descending', async () => {
    const signals = [
      { type: 'consensus', signal: 'agreement', agentId: 'a', taskId: 't1', timestamp: '2026-03-29T14:00:00Z' },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'b', taskId: 't1', timestamp: '2026-03-29T14:01:00Z' },
    ];
    writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), signals.map(s => JSON.stringify(s)).join('\n') + '\n');
    const result = await signalsHandler(projectRoot, undefined);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].signal).toBe('hallucination_caught');
  });

  it('filters by agent when query param provided', async () => {
    const signals = [
      { type: 'consensus', signal: 'agreement', agentId: 'agent-a', taskId: 't1', timestamp: '2026-03-29T14:00:00Z' },
      { type: 'consensus', signal: 'unique_confirmed', agentId: 'agent-b', taskId: 't1', timestamp: '2026-03-29T14:01:00Z' },
    ];
    writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), signals.map(s => JSON.stringify(s)).join('\n') + '\n');
    const result = await signalsHandler(projectRoot, new URLSearchParams({ agent: 'agent-a' }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].agentId).toBe('agent-a');
  });

  it('default limit caps results at 50', async () => {
    const signals = Array.from({ length: 150 }, (_, i) => ({
      type: 'consensus', signal: 'agreement', agentId: 'a', taskId: `t${i}`, timestamp: new Date(Date.now() - i * 1000).toISOString(),
    }));
    writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), signals.map(s => JSON.stringify(s)).join('\n') + '\n');
    const result = await signalsHandler(projectRoot, undefined);
    expect(result.items).toHaveLength(50);
    expect(result.total).toBe(150);
  });
});
