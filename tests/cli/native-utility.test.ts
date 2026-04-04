import { validateConfig } from '../../apps/cli/src/config';
import { ctx } from '../../apps/cli/src/mcp-context';

describe('Native Utility Provider — integration', () => {
  afterEach(() => {
    ctx.nativeTaskMap.clear();
    ctx.nativeResultMap.clear();
    ctx.nativeUtilityConfig = null;
  });

  it('validates native utility config end-to-end', () => {
    const config = validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'native', model: 'haiku' },
    });
    expect(config.utility_model?.provider).toBe('native');
    expect(config.utility_model?.model).toBe('haiku');
  });

  it('utility tasks use shorter TTL and have utilityType', () => {
    ctx.nativeTaskMap.set('util-test', {
      agentId: '_utility',
      task: 'Test utility task',
      startedAt: Date.now(),
      timeoutMs: 60_000,
      utilityType: 'lens',
    });

    expect(ctx.nativeTaskMap.get('util-test')?.utilityType).toBe('lens');
    expect(ctx.nativeTaskMap.get('util-test')?.timeoutMs).toBe(60_000);
  });

  it('nativeUtilityConfig is null by default', () => {
    expect(ctx.nativeUtilityConfig).toBeNull();
  });

  it('nativeUtilityConfig can be set and read', () => {
    ctx.nativeUtilityConfig = { model: 'haiku' };
    expect(ctx.nativeUtilityConfig.model).toBe('haiku');
  });

  it('rejects native utility with invalid model', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'native', model: 'claude-3' },
    })).toThrow('native');
  });

  it('accepts all valid native model tiers', () => {
    for (const model of ['opus', 'sonnet', 'haiku']) {
      const config = validateConfig({
        main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
        utility_model: { provider: 'native', model },
      });
      expect(config.utility_model?.model).toBe(model);
    }
  });

  it('utility tasks are distinguished from regular tasks by utilityType', () => {
    // Regular task
    ctx.nativeTaskMap.set('regular-1', {
      agentId: 'sonnet-reviewer',
      task: 'Review code',
      startedAt: Date.now(),
    });
    // Utility task
    ctx.nativeTaskMap.set('util-1', {
      agentId: '_utility',
      task: 'Generate lenses',
      startedAt: Date.now(),
      utilityType: 'lens',
    });

    const regular = [...ctx.nativeTaskMap.values()].filter(t => !t.utilityType);
    const utility = [...ctx.nativeTaskMap.values()].filter(t => !!t.utilityType);
    expect(regular).toHaveLength(1);
    expect(utility).toHaveLength(1);
    expect(regular[0].agentId).toBe('sonnet-reviewer');
    expect(utility[0].agentId).toBe('_utility');
  });
});
