import { AgentRegistry } from '@gossip/orchestrator';
import { PerformanceReader } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const NOW = new Date().toISOString();

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
    // 15 completed tasks for both agents (as consensus signals so perfReader sees them)
    const peers = ['p1', 'p2', 'p3', 'p4', 'p5'];
    for (const peer of peers) {
      signals.push({ type: 'consensus', signal: 'unique_unconfirmed', agentId: peer, taskId: `${peer}-t`, evidence: 'finding', timestamp: NOW });
    }
    // deep-agent has many agreements from diverse peers
    for (let i = 0; i < 10; i++) {
      signals.push({ type: 'consensus', signal: 'agreement', agentId: 'deep-agent', counterpartId: peers[i % peers.length], evidence: 'ok', timestamp: NOW, taskId: `d${i}` });
    }
    writeFileSync(
      join(testDir, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    );

    const reader = new PerformanceReader(testDir);
    registry.setPerformanceReader(reader);

    const match = registry.findBestMatch(['code_review']);
    expect(match?.id).toBe('deep-agent');
  });

  test('falls back to neutral when no perfReader set', () => {
    const match = registry.findBestMatch(['code_review']);
    // Both agents have same skills, no reader — either could win
    expect(match).not.toBeNull();
  });

  test('neutral weight for agents with few signals', () => {
    // Only 2 signals — below the 3-signal threshold in perfReader
    const signals = [
      { type: 'consensus', signal: 'agreement', agentId: 'deep-agent', counterpartId: 'p1', taskId: 't1', evidence: 'ok', timestamp: NOW },
      { type: 'consensus', signal: 'agreement', agentId: 'deep-agent', counterpartId: 'p1', taskId: 't2', evidence: 'ok', timestamp: NOW },
    ];
    writeFileSync(
      join(testDir, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    );

    const reader = new PerformanceReader(testDir);
    registry.setPerformanceReader(reader);

    // Both should get neutral weight, so either could win
    const match = registry.findBestMatch(['code_review']);
    expect(match).not.toBeNull();
  });
});
