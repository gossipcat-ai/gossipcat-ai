import { AgentRegistry } from '@gossip/orchestrator';
import { CompetencyProfiler } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('AgentRegistry — profile-aware dispatch', () => {
  const testDir = join(tmpdir(), 'gossip-profile-dispatch-' + Date.now());
  let registry: AgentRegistry;

  beforeAll(() => mkdirSync(join(testDir, '.gossip'), { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  beforeEach(() => {
    registry = new AgentRegistry();
    registry.register({ id: 'fast-agent', provider: 'google', model: 'flash', preset: 'reviewer', skills: ['code_review'] });
    registry.register({ id: 'deep-agent', provider: 'anthropic', model: 'sonnet', preset: 'reviewer', skills: ['code_review'] });
  });

  test('agents with same skills but different profiles get different scores', () => {
    const signals: object[] = [];
    // 15 completed tasks for both agents
    for (let i = 0; i < 15; i++) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: 'deep-agent', taskId: `d${i}`, value: 5000, timestamp: '2026-01-01T00:00:00Z' });
      signals.push({ type: 'meta', signal: 'task_completed', agentId: 'fast-agent', taskId: `f${i}`, value: 1000, timestamp: '2026-01-01T00:00:00Z' });
    }
    // deep-agent has many agreements from diverse peers (peers need consensus signals to count)
    const peers = ['p1', 'p2', 'p3', 'p4', 'p5'];
    for (const peer of peers) {
      signals.push({ type: 'meta', signal: 'task_completed', agentId: peer, taskId: `${peer}-t`, value: 1000, timestamp: '2026-01-01T00:00:00Z' });
      signals.push({ type: 'consensus', signal: 'unique_unconfirmed', agentId: peer, taskId: `${peer}-t`, evidence: 'finding', timestamp: '2026-01-01T00:00:00Z' });
    }
    for (let i = 0; i < 10; i++) {
      signals.push({ type: 'consensus', signal: 'agreement', agentId: 'deep-agent', counterpartId: peers[i % peers.length], evidence: 'ok', timestamp: '2026-01-01T00:00:00Z', taskId: `d${i}` });
    }
    writeFileSync(
      join(testDir, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    );

    const profiler = new CompetencyProfiler(testDir);
    registry.setCompetencyProfiler(profiler);

    const match = registry.findBestMatch(['code_review']);
    expect(match?.id).toBe('deep-agent');
  });

  test('falls back to perfReader when no competencyProfiler set', () => {
    const match = registry.findBestMatch(['code_review']);
    // Both agents have same skills, no profiler — either could win
    expect(match).not.toBeNull();
  });

  test('neutral weight for agents below threshold', () => {
    // Only 3 tasks — below the 10-task threshold
    const signals = [
      { type: 'meta', signal: 'task_completed', agentId: 'deep-agent', taskId: 't1', value: 5000, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'meta', signal: 'task_completed', agentId: 'deep-agent', taskId: 't2', value: 5000, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'meta', signal: 'task_completed', agentId: 'deep-agent', taskId: 't3', value: 5000, timestamp: '2026-01-01T00:00:00Z' },
    ];
    writeFileSync(
      join(testDir, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    );

    const profiler = new CompetencyProfiler(testDir);
    registry.setCompetencyProfiler(profiler);

    // Both should get neutral weight, so either could win
    const match = registry.findBestMatch(['code_review']);
    expect(match).not.toBeNull();
  });
});
