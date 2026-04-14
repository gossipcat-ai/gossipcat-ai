import { overviewHandler } from '@gossip/relay/dashboard/api-overview';
import { agentsHandler } from '@gossip/relay/dashboard/api-agents';
import { skillsGetHandler, skillsBindHandler } from '@gossip/relay/dashboard/api-skills';
import { memoryHandler } from '@gossip/relay/dashboard/api-memory';
import { autoMemoryHandler } from '@gossip/relay/dashboard/api-auto-memory';
import { tasksHandler } from '@gossip/relay/dashboard/api-tasks';
import { signalsHandler } from '@gossip/relay/dashboard/api-signals';
import { consensusHandler } from '@gossip/relay/dashboard/api-consensus';
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
      hourlyActivity: new Array(12).fill(0),
    });
  });

  it('counts agents by type', async () => {
    const configs = [
      { id: 'a', provider: 'anthropic', model: 'm', skills: [], native: true },
      { id: 'b', provider: 'google', model: 'm', skills: [] },
      { id: 'c', provider: 'google', model: 'm', skills: [] },
    ];
    const result = await overviewHandler(projectRoot, { agentConfigs: configs as any, relayConnections: 2, connectedAgentIds: [] });
    // agentsOnline now counts only connected agents (not native configs).
    expect(result.agentsOnline).toBe(0);
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

describe('Auto-Memory API', () => {
  let fakeHome: string;
  let projectRoot: string;
  let memDir: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'gossip-home-'));
    // Pick a synthetic project root — test encoding is `-Users-test-work-demo`.
    projectRoot = '/Users/test/work/demo';
    memDir = join(fakeHome, '.claude', 'projects', '-Users-test-work-demo', 'memory');
  });

  it('returns empty knowledge when dir is absent', async () => {
    const result = await autoMemoryHandler(projectRoot, fakeHome);
    expect(result).toEqual({ knowledge: [] });
  });

  it('reads .md files without frontmatter', async () => {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'session_2026_04_15.md'), '# Session notes\n\nSome content');
    const result = await autoMemoryHandler(projectRoot, fakeHome);
    expect(result.knowledge).toHaveLength(1);
    expect(result.knowledge[0].filename).toBe('session_2026_04_15.md');
    expect(result.knowledge[0].frontmatter).toEqual({});
    expect(result.knowledge[0].content).toContain('Session notes');
    expect(result.knowledge[0].agentId).toBe('_auto');
  });

  it('parses frontmatter when present', async () => {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'project_example.md'),
      '---\nname: example\ntype: project\n---\nBody text here',
    );
    const result = await autoMemoryHandler(projectRoot, fakeHome);
    expect(result.knowledge).toHaveLength(1);
    expect(result.knowledge[0].frontmatter.name).toBe('example');
    expect(result.knowledge[0].frontmatter.type).toBe('project');
    expect(result.knowledge[0].content).toBe('Body text here');
  });

  it('ignores non-md files', async () => {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'keep.md'), 'ok');
    writeFileSync(join(memDir, 'ignore.txt'), 'no');
    writeFileSync(join(memDir, 'notes.json'), '{}');
    const result = await autoMemoryHandler(projectRoot, fakeHome);
    expect(result.knowledge.map((k) => k.filename)).toEqual(['keep.md']);
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

describe('Consensus API pagination', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-consensus-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  function writeConsensusSignals(runs: number) {
    // Each "run" needs >= 2 agents and >= 3 signals to be included
    const signals: string[] = [];
    for (let r = 0; r < runs; r++) {
      const consensusId = `run-${String(r).padStart(3, '0')}`;
      const ts = new Date(Date.now() - r * 60000).toISOString();
      signals.push(JSON.stringify({ type: 'consensus', taskId: `t${r}-a`, consensusId, signal: 'agreement', agentId: 'agent-a', counterpartId: 'agent-b', timestamp: ts }));
      signals.push(JSON.stringify({ type: 'consensus', taskId: `t${r}-b`, consensusId, signal: 'unique_confirmed', agentId: 'agent-b', timestamp: ts }));
      signals.push(JSON.stringify({ type: 'consensus', taskId: `t${r}-c`, consensusId, signal: 'disagreement', agentId: 'agent-a', counterpartId: 'agent-c', timestamp: ts }));
      signals.push(JSON.stringify({ type: 'consensus', taskId: `t${r}-d`, consensusId, signal: 'hallucination_caught', agentId: 'agent-c', timestamp: ts }));
    }
    writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), signals.join('\n') + '\n');
  }

  it('returns empty for fresh project', async () => {
    const result = await consensusHandler(projectRoot);
    expect(result.runs).toEqual([]);
    expect(result.totalRuns).toBe(0);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
  });

  it('returns all runs when under page size', async () => {
    writeConsensusSignals(3);
    const result = await consensusHandler(projectRoot);
    expect(result.runs).toHaveLength(3);
    expect(result.totalRuns).toBe(3);
  });

  it('paginates with page and pageSize params', async () => {
    writeConsensusSignals(25);
    const page1 = await consensusHandler(projectRoot, new URLSearchParams({ page: '1', pageSize: '10' }));
    expect(page1.runs).toHaveLength(10);
    expect(page1.totalRuns).toBe(25);
    expect(page1.page).toBe(1);

    const page3 = await consensusHandler(projectRoot, new URLSearchParams({ page: '3', pageSize: '10' }));
    expect(page3.runs).toHaveLength(5);
    expect(page3.totalRuns).toBe(25);
    expect(page3.page).toBe(3);
  });

  it('caps pageSize at 50', async () => {
    writeConsensusSignals(60);
    const result = await consensusHandler(projectRoot, new URLSearchParams({ pageSize: '100' }));
    expect(result.runs).toHaveLength(50);
    expect(result.pageSize).toBe(50);
    expect(result.totalRuns).toBe(60);
  });

  it('returns empty runs for page beyond total', async () => {
    writeConsensusSignals(5);
    const result = await consensusHandler(projectRoot, new URLSearchParams({ page: '10' }));
    expect(result.runs).toHaveLength(0);
    expect(result.totalRuns).toBe(5);
  });
});
