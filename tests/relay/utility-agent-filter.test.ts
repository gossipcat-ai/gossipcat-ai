import { overviewHandler } from '@gossip/relay/dashboard/api-overview';
import { agentsHandler } from '@gossip/relay/dashboard/api-agents';
import { tasksHandler } from '@gossip/relay/dashboard/api-tasks';
import { isUtilityAgent, UTILITY_AGENT_IDS } from '@gossip/relay/dashboard/utility-agents';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('utility-agents helper', () => {
  it('marks _utility as utility and normal agents as non-utility', () => {
    expect(isUtilityAgent('_utility')).toBe(true);
    expect(isUtilityAgent('sonnet-reviewer')).toBe(false);
    expect(UTILITY_AGENT_IDS.has('_utility')).toBe(true);
  });
});

describe('dashboard readers exclude _utility tasks', () => {
  function setup(): string {
    const root = mkdtempSync(join(tmpdir(), 'gossip-util-filter-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const now = new Date().toISOString();
    const graph = [
      { type: 'task.created', taskId: 't1', agentId: 'alice', task: 'review X', timestamp: now },
      { type: 'task.completed', taskId: 't1', timestamp: now, duration: 1000, inputTokens: 10, outputTokens: 20 },
      { type: 'task.created', taskId: 't2', agentId: 'bob', task: 'review Y', timestamp: now },
      { type: 'task.completed', taskId: 't2', timestamp: now, duration: 1500, inputTokens: 5, outputTokens: 15 },
      { type: 'task.created', taskId: 't3', agentId: '_utility', task: 'skill_develop:trust_boundaries', timestamp: now },
      { type: 'task.completed', taskId: 't3', timestamp: now, duration: 500 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(root, '.gossip', 'task-graph.jsonl'), graph);
    return root;
  }

  it('api-tasks skips _utility', async () => {
    const root = setup();
    const r = await tasksHandler(root);
    const ids = r.items.map((t) => t.agentId);
    expect(ids).toContain('alice');
    expect(ids).toContain('bob');
    expect(ids).not.toContain('_utility');
  });

  it('api-agents readTaskGraphByAgent skips _utility', async () => {
    const root = setup();
    const configs = [
      { id: 'alice', provider: 'anthropic', model: 'm', skills: [] },
      { id: 'bob', provider: 'anthropic', model: 'm', skills: [] },
    ];
    const r = await agentsHandler(root, configs as any, []);
    const ids = r.map((a) => a.id);
    expect(ids).not.toContain('_utility');
    // alice/bob still included with their totalTokens from task-graph
    const alice = r.find((a) => a.id === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.totalTokens).toBe(30);
  });

  it('api-overview does not count _utility task in hourly buckets', async () => {
    const root = setup();
    const r = await overviewHandler(root, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
    const totalHourly = r.hourlyActivity.reduce((a, b) => a + b, 0);
    // 3 task.created lines total, 1 belongs to _utility → 2 counted in buckets
    expect(totalHourly).toBe(2);
  });
});
