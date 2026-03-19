import { AgentRegistry } from '@gossip/orchestrator';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('registers and retrieves an agent', () => {
    registry.register({ id: 'a1', provider: 'anthropic', model: 'claude', skills: ['typescript'] });
    expect(registry.get('a1')?.model).toBe('claude');
    expect(registry.count).toBe(1);
  });

  it('returns undefined for unknown agent', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('finds best match by skill overlap', () => {
    registry.register({ id: 'arch', provider: 'anthropic', model: 'claude', skills: ['typescript', 'system_design', 'code_review'] });
    registry.register({ id: 'impl', provider: 'openai', model: 'gpt', skills: ['typescript', 'react', 'implementation'] });

    const match = registry.findBestMatch(['typescript', 'implementation']);
    expect(match?.id).toBe('impl'); // 2 overlap vs 1
  });

  it('returns null when no agents registered', () => {
    expect(registry.findBestMatch(['typescript'])).toBeNull();
  });

  it('returns null when no skills overlap', () => {
    registry.register({ id: 'a1', provider: 'local', model: 'qwen', skills: ['python'] });
    expect(registry.findBestMatch(['rust'])).toBeNull();
  });

  it('finds all agents with a specific skill', () => {
    registry.register({ id: 'a1', provider: 'anthropic', model: 'claude', skills: ['typescript', 'code_review'] });
    registry.register({ id: 'a2', provider: 'openai', model: 'gpt', skills: ['typescript', 'implementation'] });
    registry.register({ id: 'a3', provider: 'local', model: 'qwen', skills: ['python'] });

    const tsAgents = registry.findBySkill('typescript');
    expect(tsAgents).toHaveLength(2);
    expect(tsAgents.map(a => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('returns empty array when no agents have the skill', () => {
    registry.register({ id: 'a1', provider: 'local', model: 'qwen', skills: ['python'] });
    expect(registry.findBySkill('rust')).toHaveLength(0);
  });

  it('unregisters an agent', () => {
    registry.register({ id: 'a1', provider: 'anthropic', model: 'claude', skills: ['typescript'] });
    registry.unregister('a1');
    expect(registry.get('a1')).toBeUndefined();
    expect(registry.count).toBe(0);
  });

  it('unregistering nonexistent agent is a no-op', () => {
    registry.unregister('nonexistent');
    expect(registry.count).toBe(0);
  });

  it('getAll returns all registered agents', () => {
    registry.register({ id: 'a1', provider: 'anthropic', model: 'claude', skills: ['ts'] });
    registry.register({ id: 'a2', provider: 'openai', model: 'gpt', skills: ['py'] });
    expect(registry.getAll()).toHaveLength(2);
  });

  it('overwrites agent with same id', () => {
    registry.register({ id: 'a1', provider: 'anthropic', model: 'claude-3', skills: ['ts'] });
    registry.register({ id: 'a1', provider: 'anthropic', model: 'claude-4', skills: ['ts', 'review'] });
    expect(registry.count).toBe(1);
    expect(registry.get('a1')?.model).toBe('claude-4');
  });
});
