import { TeamManager } from '../../packages/orchestrator/src/team-manager';
import { AgentConfig } from '../../packages/orchestrator/src/types';

function mockRegistry(agents: AgentConfig[] = []) {
  const store = new Map<string, AgentConfig>();
  agents.forEach(a => store.set(a.id, a));
  return {
    get: (id: string) => store.get(id),
    getAll: () => Array.from(store.values()),
    register: (c: AgentConfig) => store.set(c.id, c),
    unregister: (id: string) => store.delete(id),
  };
}

const baseAgent: AgentConfig = {
  id: 'gemini-researcher',
  provider: 'google',
  model: 'gemini-2.0-flash',
  preset: 'reviewer',
  skills: ['code_review', 'typescript'],
};

describe('TeamManager', () => {
  let tm: TeamManager;
  let registry: ReturnType<typeof mockRegistry>;

  beforeEach(() => {
    registry = mockRegistry([baseAgent]);
    tm = new TeamManager({ registry, pipeline: {}, projectRoot: '/tmp/test-gossip' });
  });

  test('proposeAdd returns CHOICES confirmation with agent details', () => {
    const config: AgentConfig = {
      id: 'gemini-security',
      provider: 'google',
      model: 'gemini-2.0-flash',
      preset: 'reviewer',
      skills: ['security_audit', 'vulnerability_research'],
    };
    const result = tm.proposeAdd(config);
    expect(result.text).toContain('gemini-security');
    expect(result.text).toContain('security_audit');
    expect(result.text).toContain('[confirm_add]');
    expect(result.text).toContain('[cancel]');
    expect(tm.pendingAction).toEqual({ action: 'add', agentId: 'gemini-security', config });
  });

  test('proposeRemove returns error for unknown agent', () => {
    const result = tm.proposeRemove('nonexistent');
    expect(result.text).toContain('not found');
    expect(tm.pendingAction).toBeNull();
  });

  test('proposeRemove blocks removal when active tasks exist', () => {
    const pipeline = { getActiveTasks: (_id: string) => [{ id: 't1' }, { id: 't2' }] };
    tm = new TeamManager({ registry, pipeline, projectRoot: '/tmp/test-gossip' });
    const result = tm.proposeRemove('gemini-researcher');
    expect(result.text).toContain('2 active tasks');
    expect(result.text).toContain('[wait_and_remove]');
    expect(result.text).toContain('[force_remove]');
  });

  test('proposeRemove allows removal when no active tasks', () => {
    const pipeline = { getActiveTasks: () => [] };
    tm = new TeamManager({ registry, pipeline, projectRoot: '/tmp/test-gossip' });
    const result = tm.proposeRemove('gemini-researcher');
    expect(result.text).toContain('[confirm_remove]');
    expect(result.text).not.toContain('active tasks');
  });

  test('detectSkillGap returns suggestion when skill missing', () => {
    const result = tm.detectSkillGap('security_audit');
    expect(result).not.toBeNull();
    expect(result!.text).toContain("'security_audit'");
    expect(result!.text).toContain('[suggest_add]');
  });

  test('detectSkillGap returns null when skill is covered', () => {
    const result = tm.detectSkillGap('code_review');
    expect(result).toBeNull();
  });

  test('detectScopeChange returns suggestion when topics diverge', () => {
    const history = [
      'deploy kubernetes cluster to production',
      'configure nginx reverse proxy',
      'set up monitoring with grafana',
      'optimize database queries',
      'implement CI/CD pipeline',
    ];
    const result = tm.detectScopeChange(history, 'React frontend application');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('[re_evaluate]');
  });

  test('detectScopeChange returns null when topics align', () => {
    const history = [
      'fix react component rendering',
      'update react hooks usage',
      'refactor frontend state management',
      'add react tests for components',
      'improve frontend performance',
    ];
    const result = tm.detectScopeChange(history, 'react frontend components');
    expect(result).toBeNull();
  });
});
