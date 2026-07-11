import { selectUtilityFallbackProvider } from '../../apps/cli/src/utility-provider';
import type { ILLMProvider } from '@gossip/orchestrator';

/**
 * A tagged fake provider so assertions can read back exactly which
 * provider/model createProvider was invoked with, without any network or
 * keychain. `label` on the returned selection already encodes provider/model,
 * but the tag lets us also assert the constructed llm is the SAME candidate.
 */
function makeStubCreateProvider() {
  const calls: Array<{ provider: string; model: string; key?: string; projectRoot?: string; baseUrl?: string }> = [];
  const createProvider = ((provider: string, model: string, apiKey?: string, projectRoot?: string, baseUrl?: string): ILLMProvider => {
    calls.push({ provider, model, key: apiKey, projectRoot, baseUrl });
    return { tag: `${provider}/${model}`, generate: async () => ({ text: '' }) } as unknown as ILLMProvider;
  }) as unknown as typeof import('@gossip/orchestrator').createProvider;
  return { createProvider, calls };
}

describe('selectUtilityFallbackProvider', () => {
  it('(a) keeps the main provider when it is viable, even if an openai key is also present', async () => {
    const { createProvider, calls } = makeStubCreateProvider();
    const res = await selectUtilityFallbackProvider({
      main: { provider: 'anthropic', model: 'claude-sonnet-4-6', key: 'sk-ant' },
      agents: [],
      getKey: async (s) => (s === 'openai' ? 'sk-openai' : null),
      isCooled: () => false,
      createProvider,
    });
    expect(res.label).toBe('anthropic/claude-sonnet-4-6');
    expect(calls).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-4-6', key: 'sk-ant' }]);
  });

  it('(b) main cooled ⇒ picks openai over a keyed deepseek agent (preference order)', async () => {
    const { createProvider } = makeStubCreateProvider();
    const res = await selectUtilityFallbackProvider({
      main: { provider: 'google', model: 'gemini-2.5-pro', key: 'ai-key' },
      agents: [{ provider: 'deepseek', model: 'deepseek-chat', key_ref: 'deepseek' }],
      getKey: async (s) => (s === 'openai' ? 'sk-openai' : s === 'deepseek' ? 'sk-deep' : null),
      isCooled: (p) => p === 'google',
      createProvider,
    });
    // openai (from the curated default list) outranks the keyed deepseek agent.
    expect(res.label).toBe('openai/gpt-4o-mini');
  });

  it('(c) main cooled + only deepseek keyed ⇒ picks deepseek', async () => {
    const { createProvider } = makeStubCreateProvider();
    const res = await selectUtilityFallbackProvider({
      main: { provider: 'google', model: 'gemini-2.5-pro', key: 'ai-key' },
      agents: [{ provider: 'deepseek', model: 'deepseek-chat', key_ref: 'deepseek' }],
      getKey: async (s) => (s === 'deepseek' ? 'sk-deep' : null),
      isCooled: (p) => p === 'google',
      createProvider,
    });
    expect(res.label).toBe('deepseek/deepseek-chat');
  });

  it('(d) nothing viable ⇒ NullProvider labelled degraded/none', async () => {
    const { createProvider, calls } = makeStubCreateProvider();
    const res = await selectUtilityFallbackProvider({
      main: { provider: 'google', model: 'gemini-2.5-pro', key: null },
      agents: [],
      getKey: async () => null,
      isCooled: () => false,
      createProvider,
    });
    expect(res.label).toBe('degraded/none');
    expect(calls).toEqual([{ provider: 'none', model: 'none', key: undefined }]);
  });

  it('(e) native / none / local candidates are skipped', async () => {
    const { createProvider } = makeStubCreateProvider();
    const res = await selectUtilityFallbackProvider({
      // main is a keyless "none" host (Claude Code native orchestration).
      main: { provider: 'none', model: 'none', key: null },
      agents: [
        { provider: 'anthropic', model: 'claude-native', native: true },  // native → skip
        { provider: 'local', model: 'qwen2.5-coder' },                    // local → skip
        { provider: 'deepseek', model: 'deepseek-chat', key_ref: 'deepseek' }, // real fallback
      ],
      getKey: async (s) => (s === 'deepseek' ? 'sk-deep' : null),
      isCooled: () => false,
      createProvider,
    });
    // The native anthropic agent and the local agent must not be chosen — only
    // the keyed deepseek agent is a viable HTTP candidate.
    expect(res.label).toBe('deepseek/deepseek-chat');
  });

  it('(f) cooled providers are skipped even when keyed', async () => {
    const { createProvider } = makeStubCreateProvider();
    const res = await selectUtilityFallbackProvider({
      main: { provider: 'google', model: 'gemini-2.5-pro', key: 'ai-key' },
      agents: [],
      // openai key present but openai is cooled too ⇒ fall through to anthropic.
      getKey: async (s) => (s === 'openai' || s === 'anthropic' ? `sk-${s}` : null),
      isCooled: (p) => p === 'google' || p === 'openai',
      createProvider,
    });
    expect(res.label).toBe('anthropic/claude-haiku-4-5');
  });

  it('(g) an openai agent with a custom base_url yields a candidate that createProvider receives WITH that base_url', async () => {
    const { createProvider, calls } = makeStubCreateProvider();
    const res = await selectUtilityFallbackProvider({
      // main is a keyless native host so the openai agent becomes the fallback.
      main: { provider: 'none', model: 'none', key: null },
      agents: [
        { provider: 'openai', model: 'local-gpt', key_ref: 'openai', base_url: 'https://llm.internal/v1' },
      ],
      getKey: async (s) => (s === 'openai' ? 'sk-openai' : null),
      isCooled: () => false,
      createProvider,
      projectRoot: '/proj',
    });
    expect(res.label).toBe('openai/local-gpt');
    // createProvider must receive the agent's custom base_url + projectRoot, so
    // the fallback points at the agent's endpoint (NOT api.openai.com) and can
    // persist its own 429s. The curated openai default must not shadow it.
    const openaiCall = calls.find((c) => c.provider === 'openai');
    expect(openaiCall).toEqual({ provider: 'openai', model: 'local-gpt', key: 'sk-openai', projectRoot: '/proj', baseUrl: 'https://llm.internal/v1' });
  });

  it('all viable candidates cooled ⇒ NullProvider', async () => {
    const { createProvider } = makeStubCreateProvider();
    const res = await selectUtilityFallbackProvider({
      main: { provider: 'openai', model: 'gpt-4o', key: 'sk-openai' },
      agents: [{ provider: 'deepseek', model: 'deepseek-chat', key_ref: 'deepseek' }],
      getKey: async (s) => `sk-${s}`,
      isCooled: () => true, // everything cooled
      createProvider,
    });
    expect(res.label).toBe('degraded/none');
  });
});
