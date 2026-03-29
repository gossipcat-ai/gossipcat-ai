import { overviewHandler } from '@gossip/relay/dashboard/api-overview';
import { agentsHandler } from '@gossip/relay/dashboard/api-agents';
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
    const result = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0 });
    expect(result).toEqual({
      agentsOnline: 0, relayCount: 0, nativeCount: 0,
      consensusRuns: 0, totalFindings: 0, confirmedFindings: 0, totalSignals: 0,
    });
  });

  it('counts agents by type', async () => {
    const configs = [
      { id: 'a', provider: 'anthropic', model: 'm', skills: [], native: true },
      { id: 'b', provider: 'google', model: 'm', skills: [] },
      { id: 'c', provider: 'google', model: 'm', skills: [] },
    ];
    const result = await overviewHandler(projectRoot, { agentConfigs: configs as any, relayConnections: 2 });
    expect(result.agentsOnline).toBe(3);
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
    const result = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0 });
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
});
