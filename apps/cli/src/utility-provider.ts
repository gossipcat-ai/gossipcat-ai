/**
 * Utility-summarizer provider selection ("best keyed provider" fallback).
 *
 * The AUTOMATIC relay-side summarizers — MemoryWriter.generateCognitiveSummary,
 * SessionContext.summarizeForSession, GossipPublisher.publishGossip — call their
 * injected summaryLlm.generate() SYNCHRONOUSLY inside a post-dispatch hook. There
 * is no orchestrator turn there to dispatch a native Agent(), so they cannot use
 * the native-utility path (which branches at the explicit-task call sites). They
 * must run on a real keyed HTTP provider. When that provider defaults to the main
 * agent's and the main agent's key is quota-exhausted (e.g. a google 429 cooldown
 * recorded in .gossip/quota-state.json), every automatic summary silently fails.
 *
 * selectUtilityFallbackProvider picks the least-surprising viable provider:
 *   1. keep the MAIN provider whenever it is viable — never gratuitously switch a
 *      healthy main, so today's behavior is preserved when main is fine;
 *   2. otherwise the best keyed, non-cooled provider by preference order;
 *   3. otherwise a NullProvider that degrades summaries to '' (all three call
 *      sites already handle an empty summary gracefully).
 *
 * The helper is pure/fs-free: quota state (`isCooled`) and key lookup (`getKey`)
 * and provider construction (`createProvider`) are all injected so it unit-tests
 * without a keychain, filesystem, or MCP-boot harness.
 */
import type { ILLMProvider } from '@gossip/orchestrator';

/**
 * Curated default model per provider. Lets a key that is SET but not attached to
 * any configured agent (e.g. a stored `openai` key on a google-main host) still
 * become a reachable utility candidate.
 */
export const UTILITY_DEFAULT_MODELS: ReadonlyArray<{ provider: string; model: string }> = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'google', model: 'gemini-2.5-flash' },
];

/**
 * Ranking used only when the main provider is NOT viable. openai first = the
 * reliable, cheap key on this host; google last (spend-cap / quota prone).
 */
export const UTILITY_PREFERENCE_ORDER: readonly string[] = [
  'openai', 'anthropic', 'deepseek', 'grok', 'openclaw', 'google',
];

/** Providers that never make a keyed HTTP summary call and can't be a fallback. */
const NON_HTTP_PROVIDERS = new Set(['native', 'none', 'local']);

interface Candidate { provider: string; model: string; key: string; baseUrl?: string }

export interface SelectUtilityFallbackOpts {
  main: { provider: string; model: string; key: string | null };
  agents: Array<{ provider: string; model: string; key_ref?: string; native?: boolean; base_url?: string }>;
  getKey: (service: string) => Promise<string | null>;
  isCooled: (provider: string) => boolean;
  createProvider: typeof import('@gossip/orchestrator').createProvider;
  /** Threaded into every createProvider call so fallback providers persist their
   *  own 429/spend-cap cooldowns to .gossip/quota-state.json (same as the main). */
  projectRoot?: string;
}

export async function selectUtilityFallbackProvider(
  opts: SelectUtilityFallbackOpts,
): Promise<{ llm: ILLMProvider; label: string }> {
  const { main, agents, getKey, isCooled, createProvider, projectRoot } = opts;

  // provider → {model, key, baseUrl}, FIRST-SEEN WINS. Sources in order: (a) main,
  // (b) each non-native agent, (c) curated defaults.
  const candidates = new Map<string, Candidate>();
  const consider = (provider: string, model: string, key: string | null | undefined, baseUrl?: string): void => {
    if (!provider || NON_HTTP_PROVIDERS.has(provider)) return;
    if (!key) return;
    if (candidates.has(provider)) return; // first-seen wins
    candidates.set(provider, { provider, model, key, baseUrl });
  };

  // (a) main
  consider(main.provider, main.model, main.key);

  // (b) each non-native agent — key via the per-agent keychain service (key_ref ?? provider).
  // Carry the agent's base_url so a custom-endpoint openai-compatible agent yields a
  // correct fallback (pointing at ITS endpoint, not api.openai.com) rather than a
  // broken entry that first-seen-wins would then shadow the curated default with.
  for (const ac of agents) {
    if (ac.native) continue;
    if (NON_HTTP_PROVIDERS.has(ac.provider) || candidates.has(ac.provider)) continue;
    consider(ac.provider, ac.model, await getKey(ac.key_ref ?? ac.provider), ac.base_url);
  }

  // (c) curated defaults — reach a set-but-unagented key. No base_url ⇒ hit the
  // provider default endpoint.
  for (const d of UTILITY_DEFAULT_MODELS) {
    if (candidates.has(d.provider)) continue;
    consider(d.provider, d.model, await getKey(d.provider));
  }

  const viable = (c: Candidate | undefined): c is Candidate => !!c && !isCooled(c.provider);

  // (1) main viable ⇒ keep it (preserve today's behavior for a healthy main).
  // `main.key` guards the shared-provider case: if main has no key, a same-provider
  // agent may own candidates.get(main.provider) — that's an agent fallback, not main.
  const mainCand = main.key ? candidates.get(main.provider) : undefined;
  if (viable(mainCand)) {
    return { llm: createProvider(mainCand.provider, mainCand.model, mainCand.key, projectRoot, mainCand.baseUrl), label: `${mainCand.provider}/${mainCand.model}` };
  }

  // (2) best viable candidate by preference order.
  for (const provider of UTILITY_PREFERENCE_ORDER) {
    const c = candidates.get(provider);
    if (viable(c)) {
      return { llm: createProvider(c.provider, c.model, c.key, projectRoot, c.baseUrl), label: `${c.provider}/${c.model}` };
    }
  }

  // (3) nothing viable ⇒ NullProvider (summaries degrade to '').
  return { llm: createProvider('none', 'none'), label: 'degraded/none' };
}
