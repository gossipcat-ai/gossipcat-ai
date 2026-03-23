import type { ConsensusReport, ConsensusFinding, ConsensusSignal, CollectResult, TaskEntry } from '@gossip/orchestrator';
import { ConsensusEngine } from '@gossip/orchestrator';

describe('Consensus types', () => {
  it('CollectResult shape is valid', () => {
    const result: CollectResult = {
      results: [],
      consensus: undefined,
    };
    expect(result.results).toEqual([]);
    expect(result.consensus).toBeUndefined();
  });

  it('ConsensusReport shape is valid', () => {
    const signal: ConsensusSignal = {
      type: 'consensus',
      taskId: 't1',
      signal: 'agreement',
      agentId: 'a1',
      evidence: 'test',
      timestamp: new Date().toISOString(),
    };
    const finding: ConsensusFinding = {
      id: 'f1',
      originalAgentId: 'a1',
      finding: 'test finding',
      tag: 'confirmed',
      confirmedBy: ['a2'],
      disputedBy: [],
      confidence: 4,
    };
    const report: ConsensusReport = {
      agentCount: 2,
      rounds: 2,
      confirmed: [finding],
      disputed: [],
      unique: [],
      newFindings: [],
      signals: [signal],
      summary: 'test summary',
    };
    expect(report.agentCount).toBe(2);
    expect(report.confirmed).toHaveLength(1);
    expect(signal.type).toBe('consensus');
  });
});

describe('ConsensusEngine', () => {
  describe('extractSummary()', () => {
    it('extracts ## Consensus Summary section', () => {
      const result = `Some long analysis...\n\n## Consensus Summary\n- SQL injection at auth.ts:47\n- Missing rate limiting on /api/tasks\n\nSome trailing text`;
      const engine = new ConsensusEngine({
        llm: null as any,
        registryGet: () => undefined,
      });
      const summary = engine.extractSummary(result);
      expect(summary).toBe('- SQL injection at auth.ts:47\n- Missing rate limiting on /api/tasks');
    });

    it('returns full result (truncated) when no summary section found', () => {
      const result = 'Found a bug at line 47. Also line 92 has issues.';
      const engine = new ConsensusEngine({
        llm: null as any,
        registryGet: () => undefined,
      });
      const summary = engine.extractSummary(result);
      expect(summary).toBe(result);
    });

    it('truncates full result at sentence boundary when no summary section', () => {
      const sentences = Array.from({ length: 50 }, (_, i) => `Finding ${i}: something is wrong at file${i}.ts:${i}.`);
      const result = sentences.join(' ');
      const engine = new ConsensusEngine({
        llm: null as any,
        registryGet: () => undefined,
      });
      const summary = engine.extractSummary(result);
      expect(summary.endsWith('.')).toBe(true);
      expect(summary.length).toBeLessThanOrEqual(2000);
    });

    it('returns empty string for empty result', () => {
      const engine = new ConsensusEngine({
        llm: null as any,
        registryGet: () => undefined,
      });
      const summary = engine.extractSummary('');
      expect(summary).toBe('');
    });

    it('handles multiple ## Consensus Summary sections (takes first)', () => {
      const result = '## Consensus Summary\n- Finding A\n\n## Consensus Summary\n- Finding B';
      const engine = new ConsensusEngine({
        llm: null as any,
        registryGet: () => undefined,
      });
      const summary = engine.extractSummary(result);
      expect(summary).toContain('Finding A');
    });
  });

  describe('dispatchCrossReview()', () => {
    it('sends cross-review prompts to each agent and collects structured responses', async () => {
      const mockLlm = {
        generate: jest.fn().mockResolvedValue({
          text: JSON.stringify([
            { action: 'agree', agentId: 'agent-b', finding: 'SQL injection', evidence: 'confirmed at auth.ts:47', confidence: 5 },
            { action: 'disagree', agentId: 'agent-b', finding: 'Rate limit bypass', evidence: 'nginx handles this', confidence: 4 },
          ]),
        }),
      };

      const engine = new ConsensusEngine({
        llm: mockLlm as any,
        registryGet: (id) => ({
          id, provider: 'google' as const, model: 'gemini-2.0-flash',
          preset: id === 'agent-a' ? 'reviewer' : 'tester', skills: [],
        }),
      });

      const results: TaskEntry[] = [
        { id: 't1', agentId: 'agent-a', task: 'review', status: 'completed', result: '## Consensus Summary\n- SQL injection at auth.ts:47\n- Rate limit bypass', startedAt: 0 },
        { id: 't2', agentId: 'agent-b', task: 'review', status: 'completed', result: '## Consensus Summary\n- Missing input validation', startedAt: 0 },
      ];

      const entries = await engine.dispatchCrossReview(results);
      expect(mockLlm.generate).toHaveBeenCalledTimes(2);
      const firstCall = mockLlm.generate.mock.calls[0][0];
      expect(firstCall[1].content).toContain('PEER FINDINGS');
      expect(entries.length).toBeGreaterThan(0);
    });

    it('gracefully skips agents whose cross-review call fails', async () => {
      let callCount = 0;
      const mockLlm = {
        generate: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error('API timeout'));
          return Promise.resolve({
            text: JSON.stringify([
              { action: 'agree', agentId: 'agent-a', finding: 'bug', evidence: 'yes', confidence: 4 },
            ]),
          });
        }),
      };

      const engine = new ConsensusEngine({
        llm: mockLlm as any,
        registryGet: (id) => ({ id, provider: 'google' as const, model: 'm', skills: [] }),
      });

      const results: TaskEntry[] = [
        { id: 't1', agentId: 'agent-a', task: 'review', status: 'completed', result: 'findings A', startedAt: 0 },
        { id: 't2', agentId: 'agent-b', task: 'review', status: 'completed', result: 'findings B', startedAt: 0 },
      ];

      const entries = await engine.dispatchCrossReview(results);
      expect(entries.length).toBeGreaterThan(0);
    });

    it('parses cross-review JSON even with markdown code fences', async () => {
      const mockLlm = {
        generate: jest.fn().mockResolvedValue({
          text: '```json\n[{"action":"agree","agentId":"agent-b","finding":"bug","evidence":"yes","confidence":4}]\n```',
        }),
      };

      const engine = new ConsensusEngine({
        llm: mockLlm as any,
        registryGet: (id) => ({ id, provider: 'google' as const, model: 'm', skills: [] }),
      });

      const results: TaskEntry[] = [
        { id: 't1', agentId: 'agent-a', task: 'review', status: 'completed', result: 'findings A', startedAt: 0 },
        { id: 't2', agentId: 'agent-b', task: 'review', status: 'completed', result: 'findings B', startedAt: 0 },
      ];

      const entries = await engine.dispatchCrossReview(results);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('agree');
    });

    it('returns empty array when LLM returns non-JSON text', async () => {
      const mockLlm = {
        generate: jest.fn().mockResolvedValue({
          text: 'I cannot produce JSON for this request.',
        }),
      };

      const engine = new ConsensusEngine({
        llm: mockLlm as any,
        registryGet: (id) => ({ id, provider: 'google' as const, model: 'm', skills: [] }),
      });

      const results: TaskEntry[] = [
        { id: 't1', agentId: 'agent-a', task: 'review', status: 'completed', result: 'findings A', startedAt: 0 },
        { id: 't2', agentId: 'agent-b', task: 'review', status: 'completed', result: 'findings B', startedAt: 0 },
      ];

      const entries = await engine.dispatchCrossReview(results);
      expect(entries).toHaveLength(0);
    });

    it('handles LLM returning empty JSON array', async () => {
      const mockLlm = {
        generate: jest.fn().mockResolvedValue({ text: '[]' }),
      };

      const engine = new ConsensusEngine({
        llm: mockLlm as any,
        registryGet: (id) => ({ id, provider: 'google' as const, model: 'm', skills: [] }),
      });

      const results: TaskEntry[] = [
        { id: 't1', agentId: 'agent-a', task: 'review', status: 'completed', result: 'findings A', startedAt: 0 },
        { id: 't2', agentId: 'agent-b', task: 'review', status: 'completed', result: 'findings B', startedAt: 0 },
      ];

      const entries = await engine.dispatchCrossReview(results);
      expect(entries).toHaveLength(0);
    });

    it('returns empty when fewer than 2 successful results', async () => {
      const engine = new ConsensusEngine({
        llm: { generate: jest.fn() } as any,
        registryGet: (id) => ({ id, provider: 'google' as const, model: 'm', skills: [] }),
      });

      const results: TaskEntry[] = [
        { id: 't1', agentId: 'agent-a', task: 'review', status: 'completed', result: 'findings', startedAt: 0 },
      ];

      const entries = await engine.dispatchCrossReview(results);
      expect(entries).toHaveLength(0);
    });

    it('applies default confidence when entry has invalid confidence', async () => {
      const mockLlm = {
        generate: jest.fn().mockResolvedValue({
          text: JSON.stringify([
            { action: 'agree', agentId: 'agent-b', finding: 'bug', evidence: 'yes', confidence: -1 },
            { action: 'agree', agentId: 'agent-b', finding: 'bug2', evidence: 'yes' },
          ]),
        }),
      };

      const engine = new ConsensusEngine({
        llm: mockLlm as any,
        registryGet: (id) => ({ id, provider: 'google' as const, model: 'm', skills: [] }),
      });

      const results: TaskEntry[] = [
        { id: 't1', agentId: 'agent-a', task: 'review', status: 'completed', result: 'findings A', startedAt: 0 },
        { id: 't2', agentId: 'agent-b', task: 'review', status: 'completed', result: 'findings B', startedAt: 0 },
      ];

      const entries = await engine.dispatchCrossReview(results);
      expect(entries.some(e => e.confidence === 1)).toBe(true);
      expect(entries.some(e => e.confidence === 3)).toBe(true);
    });
  });
});
