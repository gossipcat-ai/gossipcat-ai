import { createProvider } from '../../packages/orchestrator/src/llm-client';

describe('createProvider — deepseek timeout (regression: #522 missed the long timeout)', () => {
  it('gives deepseek the 600s timeout like openclaw, not the 120s default', () => {
    const p = createProvider('deepseek', 'deepseek-chat', 'sk-test') as any;
    expect(p.timeoutMs).toBe(600_000);
  });
  it('openclaw keeps its 600s timeout (control)', () => {
    const p = createProvider('openclaw', 'x', 'sk-test') as any;
    expect(p.timeoutMs).toBe(600_000);
  });
  it('plain openai keeps the 120s default (control)', () => {
    const p = createProvider('openai', 'gpt-4o', 'sk-test') as any;
    expect(p.timeoutMs).toBe(120_000);
  });
});
