import { SessionContext } from '@gossip/orchestrator/session-context';

describe('SessionContext', () => {
  it('registers and retrieves a plan', () => {
    const ctx = new SessionContext({ llm: null, projectRoot: '/tmp/test' });
    ctx.registerPlan({ id: 'p1', task: 'test', strategy: 'sequential', steps: [], createdAt: Date.now() });
    expect(ctx.getChainContext('p1', 1)).toBe('');
  });

  it('returns empty gossip initially', () => {
    const ctx = new SessionContext({ llm: null, projectRoot: '/tmp/test' });
    expect(ctx.getSessionGossip()).toEqual([]);
  });

  it('records plan step results for chain context', () => {
    const ctx = new SessionContext({ llm: null, projectRoot: '/tmp/test' });
    ctx.registerPlan({ id: 'p1', task: 'test', strategy: 'sequential', steps: [{ step: 1, agentId: 'a', task: 't' }], createdAt: Date.now() });
    ctx.recordPlanStepResult('p1', 1, 'result from step 1');
    const chain = ctx.getChainContext('p1', 2);
    expect(chain).toContain('Step 1');
    expect(chain).toContain('result from step 1');
  });

  it('returns empty chain context for unknown plan', () => {
    const ctx = new SessionContext({ llm: null, projectRoot: '/tmp/test' });
    expect(ctx.getChainContext('nonexistent', 2)).toBe('');
  });

  it('truncates plan step results to 2000 chars', () => {
    const ctx = new SessionContext({ llm: null, projectRoot: '/tmp/test' });
    ctx.registerPlan({ id: 'p1', task: 'test', strategy: 'sequential', steps: [{ step: 1, agentId: 'a', task: 't' }], createdAt: Date.now() });
    ctx.recordPlanStepResult('p1', 1, 'x'.repeat(3000));
    const chain = ctx.getChainContext('p1', 2);
    expect(chain.length).toBeLessThan(2500);
  });

  it('returns a session start time', () => {
    const ctx = new SessionContext({ llm: null, projectRoot: '/tmp/test' });
    expect(ctx.getSessionStartTime()).toBeInstanceOf(Date);
  });

  it('returns empty chain context when step is 1', () => {
    const ctx = new SessionContext({ llm: null, projectRoot: '/tmp/test' });
    ctx.registerPlan({ id: 'p1', task: 'test', strategy: 'sequential', steps: [{ step: 1, agentId: 'a', task: 't' }], createdAt: Date.now() });
    expect(ctx.getChainContext('p1', 1)).toBe('');
  });

  it('ignores recordPlanStepResult for unknown plan', () => {
    const ctx = new SessionContext({ llm: null, projectRoot: '/tmp/test' });
    // Should not throw
    expect(() => ctx.recordPlanStepResult('nonexistent', 1, 'result')).not.toThrow();
  });
});
