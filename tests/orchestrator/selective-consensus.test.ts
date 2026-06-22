import { shouldSkipConsensus } from '@gossip/orchestrator';

function makeAgent(reliability: number, totalTasks: number) {
  return { reviewReliability: reliability, totalTasks };
}

describe('shouldSkipConsensus', () => {
  const highReliability = [makeAgent(0.95, 20), makeAgent(0.92, 20)];
  const lowReliability = [makeAgent(0.7, 20), makeAgent(0.6, 20)];
  const coldStart = [makeAgent(0.95, 5), makeAgent(0.92, 5)];
  const goodHistory = { rate: 0.85, uniquePeerPairings: 4 };

  test('skips for low-stakes + high reliability + balanced mode', () => {
    expect(shouldSkipConsensus('summarize the architecture', highReliability, 'balanced', goodHistory)).toBe(true);
  });

  test('never skips for security tasks', () => {
    expect(shouldSkipConsensus('security review of auth module', highReliability, 'balanced', goodHistory)).toBe(false);
  });

  test('never skips in thorough mode', () => {
    expect(shouldSkipConsensus('summarize the architecture', highReliability, 'thorough', goodHistory)).toBe(false);
  });

  test('does not skip when reliability too low', () => {
    expect(shouldSkipConsensus('summarize the architecture', lowReliability, 'balanced', goodHistory)).toBe(false);
  });

  test('does not skip during cold start', () => {
    expect(shouldSkipConsensus('summarize the architecture', coldStart, 'balanced', goodHistory)).toBe(false);
  });

  test('does not skip when agreement diversity is low', () => {
    expect(shouldSkipConsensus('summarize the architecture', highReliability, 'balanced', { rate: 0.85, uniquePeerPairings: 1 })).toBe(false);
  });

  test('does not skip when agreement rate is low', () => {
    expect(shouldSkipConsensus('summarize the architecture', highReliability, 'balanced', { rate: 0.5, uniquePeerPairings: 4 })).toBe(false);
  });

  test('does not skip for vulnerability-related tasks', () => {
    expect(shouldSkipConsensus('analyze vulnerability in parser', highReliability, 'balanced', goodHistory)).toBe(false);
  });

  test('does not skip for injection-related tasks', () => {
    expect(shouldSkipConsensus('check for injection vectors', highReliability, 'balanced', goodHistory)).toBe(false);
  });

  test('skips for research tasks', () => {
    expect(shouldSkipConsensus('research the dependency graph', highReliability, 'balanced', goodHistory)).toBe(true);
  });

  test('skips for document tasks', () => {
    expect(shouldSkipConsensus('document the API endpoints', highReliability, 'balanced', goodHistory)).toBe(true);
  });

  test('does not skip for implementation tasks', () => {
    expect(shouldSkipConsensus('implement the new feature', highReliability, 'balanced', goodHistory)).toBe(false);
  });
});
