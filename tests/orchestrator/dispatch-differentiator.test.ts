import { DispatchDifferentiator } from '@gossip/orchestrator';
import { AgentScore } from '@gossip/orchestrator';

function makeProfile(id: string, strengths: Record<string, number>): AgentScore {
  return {
    agentId: id,
    categoryStrengths: strengths,
    accuracy: 0.7, uniqueness: 0.5, reliability: 0.7,
    totalSignals: 20, agreements: 10, disagreements: 2,
    uniqueFindings: 3, hallucinations: 0,
    consecutiveFailures: 0, circuitOpen: false,
  };
}

describe('DispatchDifferentiator', () => {
  const differ = new DispatchDifferentiator();

  test('generates complementary focus for two agents with different strengths', () => {
    const profiles = [
      makeProfile('agent-a', { trust_boundaries: 0.9, injection_vectors: 0.8 }),
      makeProfile('agent-b', { input_validation: 0.85, type_safety: 0.7 }),
    ];
    const result = differ.differentiate(profiles, 'security review');
    expect(result.size).toBe(2);
    expect(result.get('agent-a')).toContain('trust');
    expect(result.get('agent-b')).toContain('validation');
  });

  test('returns empty map for single agent', () => {
    const profiles = [makeProfile('agent-a', { trust_boundaries: 0.9 })];
    const result = differ.differentiate(profiles, 'review');
    expect(result.size).toBe(0);
  });

  test('returns empty map when profiles are identical (cold start fallback)', () => {
    const profiles = [
      makeProfile('agent-a', {}),
      makeProfile('agent-b', {}),
    ];
    const result = differ.differentiate(profiles, 'review');
    expect(result.size).toBe(0);
  });

  test('does not reveal peer names in differentiation prompts', () => {
    const profiles = [
      makeProfile('agent-a', { trust_boundaries: 0.9 }),
      makeProfile('agent-b', { input_validation: 0.85 }),
    ];
    const result = differ.differentiate(profiles, 'review');
    const promptA = result.get('agent-a')!;
    const promptB = result.get('agent-b')!;
    expect(promptA).not.toContain('agent-b');
    expect(promptB).not.toContain('agent-a');
  });

  test('handles 3+ agents', () => {
    const profiles = [
      makeProfile('a', { trust_boundaries: 0.9 }),
      makeProfile('b', { input_validation: 0.85 }),
      makeProfile('c', { concurrency: 0.8, resource_exhaustion: 0.7 }),
    ];
    const result = differ.differentiate(profiles, 'review');
    expect(result.size).toBe(3);
  });

  test('assigns unassigned categories to agents with no unique strengths', () => {
    const profiles = [
      makeProfile('a', { trust_boundaries: 0.9 }),
      makeProfile('b', { trust_boundaries: 0.85 }), // same strength, will be taken by 'a'
    ];
    const result = differ.differentiate(profiles, 'review');
    expect(result.size).toBe(2);
    // 'b' should get a different category since trust_boundaries was taken by 'a'
    expect(result.get('b')).not.toContain('trust');
  });
});
