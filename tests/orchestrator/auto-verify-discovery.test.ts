/**
 * Discovery tests for apps/cli/src/handlers/auto-verify-discovery.ts.
 *
 * Spec: docs/superpowers/specs/2026-05-21-consensus-auto-verify-design.md.
 */
import { discoverVerifier, isVerifierSuitable } from '../../apps/cli/src/handlers/auto-verify-discovery';
import type { AgentConfig } from '../../packages/orchestrator/src/types';

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a',
    provider: 'anthropic',
    model: 'sonnet',
    skills: [],
    ...over,
  } as AgentConfig;
}

describe('isVerifierSuitable', () => {
  test('native agent is suitable', () => {
    expect(isVerifierSuitable(agent({ native: true }))).toBe(true);
  });
  test('relay agent with verification skill is suitable', () => {
    expect(isVerifierSuitable(agent({ native: false, skills: ['verification'] }))).toBe(true);
  });
  test('relay agent without verification skill is NOT suitable', () => {
    expect(isVerifierSuitable(agent({ native: false, skills: ['review'] }))).toBe(false);
  });
  test('agent with empty skills + non-native is NOT suitable', () => {
    expect(isVerifierSuitable(agent({ skills: [] }))).toBe(false);
  });
});

describe('discoverVerifier — override path', () => {
  test('override → native agent → native_utility binding', () => {
    const team = [agent({ id: 'haiku', native: true }), agent({ id: 'gemini' })];
    expect(discoverVerifier(team, 'haiku')).toEqual({ kind: 'native_utility', agentId: 'haiku' });
  });
  test('override → relay agent with verification → relay_worker binding', () => {
    const team = [agent({ id: 'gemini-tester', skills: ['verification'] })];
    expect(discoverVerifier(team, 'gemini-tester')).toEqual({ kind: 'relay_worker', agentId: 'gemini-tester' });
  });
  test('override names agent not in team → undefined', () => {
    expect(discoverVerifier([agent({ id: 'x' })], 'not-here')).toBeUndefined();
  });
  test('override agent exists but fails suitability → undefined', () => {
    const team = [agent({ id: 'relay-no-skill', skills: ['something-else'] })];
    expect(discoverVerifier(team, 'relay-no-skill')).toBeUndefined();
  });
});

describe('discoverVerifier — default discovery', () => {
  test('no override + native subagent → native_utility', () => {
    const team = [agent({ id: 'relay', skills: ['review'] }), agent({ id: 'haiku', native: true })];
    expect(discoverVerifier(team)).toEqual({ kind: 'native_utility', agentId: 'haiku' });
  });
  test('no override + only relay verification-skilled → relay_worker', () => {
    const team = [agent({ id: 'gemini-tester', skills: ['verification'] }), agent({ id: 'noop', skills: [] })];
    expect(discoverVerifier(team)).toEqual({ kind: 'relay_worker', agentId: 'gemini-tester' });
  });
  test('no override + no suitable agent → undefined (no_suitable_verifier)', () => {
    const team = [agent({ id: 'r1', skills: ['review'] }), agent({ id: 'r2', skills: ['security'] })];
    expect(discoverVerifier(team)).toBeUndefined();
  });
  test('no override + empty team → undefined (team_empty)', () => {
    expect(discoverVerifier([])).toBeUndefined();
  });
  test('empty-string override is ignored (falls through to default)', () => {
    const team = [agent({ id: 'haiku', native: true })];
    expect(discoverVerifier(team, '')).toEqual({ kind: 'native_utility', agentId: 'haiku' });
  });
});
