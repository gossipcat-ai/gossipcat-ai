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

describe('createProvider — grok (xAI) provider arm', () => {
  it('returns an OpenAIProvider pointed at the xAI endpoint with the Grok label', () => {
    const p = createProvider('grok', 'grok-4', 'sk-test') as any;
    expect(p.constructor.name).toBe('OpenAIProvider');
    expect(p.baseUrl).toBe('https://api.x.ai/v1');
    expect(p.providerLabel).toBe('Grok');
  });
  it('gives grok the 600s timeout (grok-4 is a long-streaming reasoning model)', () => {
    const p = createProvider('grok', 'grok-4', 'sk-test') as any;
    expect(p.timeoutMs).toBe(600_000);
  });
  it('honours an explicit base_url override', () => {
    const p = createProvider('grok', 'grok-4', 'sk-test', undefined, 'https://proxy.example/v1') as any;
    expect(p.baseUrl).toBe('https://proxy.example/v1');
  });
});
