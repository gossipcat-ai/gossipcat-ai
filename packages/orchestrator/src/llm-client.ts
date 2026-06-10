/**
 * Multi-provider LLM abstraction.
 *
 * Uses native fetch (no SDK dependencies). Supports:
 * - Anthropic (Claude)
 * - OpenAI (GPT)
 * - Google (Gemini)
 * - Ollama (local models)
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { ToolDefinition, LLMMessage } from '@gossip/types';
import { LLMResponse } from './types';
import { log as _log } from './log';
import { recordAuthFailure, clearAuthFailure } from './auth-state';

// ─── 503 Retry Helper ───────────────────────────────────────────────────────

/**
 * Wraps fetch with one-shot retry on 503 (service unavailable / overloaded).
 * Many 503s clear within seconds — a single short retry recovers the request
 * before triggering the cooldown dance in QuotaTracker.handle503. If the retry
 * also returns 503, returns that response and lets the caller's handle503()
 * set the cooldown as before. The caller does NOT need to know whether a
 * retry happened.
 *
 * Notes:
 * - Drains the first response body before retrying so the connection releases.
 * - Honours Retry-After if present (capped at 30s to avoid oversleeping).
 * - Reuses the caller's RequestInit including AbortSignal — the original
 *   timeout budget still applies across both attempts combined.
 */
async function fetchWithRetry503(
  url: string,
  init: RequestInit,
  providerName: string,
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 503) return res;

  // Drain the body so the connection can be released before we retry.
  try { await res.text(); } catch { /* ignore */ }

  // Respect Retry-After (seconds), else default to 5s; cap at 30s.
  const retryAfter = res.headers.get('Retry-After') ?? res.headers.get('retry-after');
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const retryMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : 5_000;

  _log(providerName, `503 service unavailable — retrying once after ${Math.round(retryMs / 1000)}s`);
  await new Promise(r => setTimeout(r, retryMs));

  // Second attempt. If it also returns 503, the caller's existing handle503
  // path takes over and sets the cooldown.
  return fetch(url, init);
}

// ─── Provider Placeholder Detection ─────────────────────────────────────────
//
// Matches placeholder strings that llm-client emits when a provider returns
// an unrecoverable transport-level error (MALFORMED_FUNCTION_CALL, safety
// block, empty candidates). Shared between llm-client.ts and worker-agent.ts
// so both files use the same literal — no drift between emission and detection.
//
// worker-agent.ts imports this to detect placeholder responses and retry once.
// dispatch-pipeline.ts / completion-signals.ts use it to suppress format_compliance:0
// and emit transport_failure instead (so the mislabelling never reaches scoring).
//
// Requires a known provider token (Gemini/Anthropic/OpenAI) after "No response from" so
// the worker's own "[No response from agent]" fallback (worker-agent.ts FINAL_RESULT path)
// does NOT match — consensus c520ef0b-88114e21:f5 caught the false-positive.
export const PROVIDER_PLACEHOLDER_RE = /^\[(?:No response from (?:Gemini|Anthropic|OpenAI|OpenClaw)|Response blocked by )/;

// ─── Quota Exception ────────────────────────────────────────────────────────

export class QuotaExhaustedException extends Error {
  public readonly provider: string;
  public readonly retryAfterMs: number;

  constructor(opts: { message: string; provider: string; retryAfterMs: number }) {
    super(opts.message);
    this.name = 'QuotaExhaustedException';
    this.provider = opts.provider;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

type CooldownReason = 'quota' | 'unavailable';

interface QuotaProviderState {
  exhaustedUntil: number;
  consecutive429s: number;
  reason?: CooldownReason;
}

interface QuotaStateFile {
  [provider: string]: QuotaProviderState;
}

// ─── Shared Quota Tracker ──────────────────────────────────────────────────

class QuotaTracker {
  private consecutive429s = 0;
  private exhaustedUntil = 0;
  private reason: CooldownReason = 'quota';
  private statePath: string | null;

  constructor(private provider: string, projectRoot?: string) {
    this.statePath = projectRoot ? join(projectRoot, '.gossip', 'quota-state.json') : null;
    this.load();
  }

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const state: QuotaStateFile = JSON.parse(readFileSync(this.statePath, 'utf-8'));
      if (state[this.provider]) {
        this.exhaustedUntil = state[this.provider].exhaustedUntil;
        this.consecutive429s = state[this.provider].consecutive429s;
        this.reason = state[this.provider].reason ?? 'quota';
      }
    } catch { /* start fresh */ }
  }

  private persist(): void {
    if (!this.statePath) return;
    try {
      const dir = join(this.statePath, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Merge with existing state (other providers may have entries)
      let existing: QuotaStateFile = {};
      try { existing = JSON.parse(readFileSync(this.statePath, 'utf-8')); } catch { /* fresh */ }
      existing[this.provider] = { exhaustedUntil: this.exhaustedUntil, consecutive429s: this.consecutive429s, reason: this.reason };
      writeFileSync(this.statePath, JSON.stringify(existing, null, 2));
    } catch { /* best-effort */ }
  }

  /** Check if quota/availability cooldown is active. Throws QuotaExhaustedException if so. */
  checkBeforeRequest(): void {
    if (this.exhaustedUntil > Date.now()) {
      const remainingMs = this.exhaustedUntil - Date.now();
      const label = this.reason === 'unavailable' ? 'service unavailable' : 'quota exhausted';
      _log(this.provider, `${label}, ${Math.round(remainingMs / 1000)}s cooldown remaining`);
      throw new QuotaExhaustedException({
        message: `${this.provider} ${label} — ${Math.round(remainingMs / 1000)}s cooldown remaining`,
        provider: this.provider,
        retryAfterMs: remainingMs,
      });
    }
  }

  /** Handle a 429 response. Parses Retry-After, sets cooldown, persists, throws. */
  handle429(res: Response, errBody: string): never {
    this.consecutive429s++;
    this.reason = 'quota';
    const retryAfter = this.parseRetryAfter(res);
    const cooldownMs = retryAfter ?? Math.min(60_000 * Math.pow(2, this.consecutive429s - 1), 300_000);
    this.exhaustedUntil = Date.now() + cooldownMs;
    this.persist();
    _log(this.provider, `429 rate limited (${this.consecutive429s}x) — cooling down ${cooldownMs / 1000}s`);
    throw new QuotaExhaustedException({
      message: `${this.provider} quota exhausted (429 #${this.consecutive429s}): ${errBody}`,
      provider: this.provider,
      retryAfterMs: cooldownMs,
    });
  }

  /**
   * Handle a 503 (service unavailable / overloaded) response. Same backoff
   * pattern as 429 but with shorter initial cooldown — 503s typically clear
   * within seconds-to-minutes rather than the longer rate-limit windows.
   * Uses a separate reason ('unavailable') so subsequent checkBeforeRequest
   * calls don't mislabel the cooldown as quota exhaustion.
   */
  handle503(res: Response, errBody: string): never {
    this.consecutive429s++;
    this.reason = 'unavailable';
    const retryAfter = this.parseRetryAfter(res);
    // Shorter base cooldown for 503: 15s, 30s, 60s, 120s, capped at 300s
    const cooldownMs = retryAfter ?? Math.min(15_000 * Math.pow(2, this.consecutive429s - 1), 300_000);
    this.exhaustedUntil = Date.now() + cooldownMs;
    this.persist();
    _log(this.provider, `503 service unavailable (${this.consecutive429s}x) — cooling down ${cooldownMs / 1000}s`);
    throw new QuotaExhaustedException({
      message: `${this.provider} service unavailable (503 #${this.consecutive429s}): ${errBody}`,
      provider: this.provider,
      retryAfterMs: cooldownMs,
    });
  }

  /** Reset on successful response. */
  onSuccess(): void {
    if (this.consecutive429s > 0 || this.exhaustedUntil > 0) {
      this.consecutive429s = 0;
      this.exhaustedUntil = 0;
      this.reason = 'quota';
      this.persist();
    }
  }

  private parseRetryAfter(res: Response): number | null {
    const header = res.headers.get('Retry-After') ?? res.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
    const dateMs = Date.parse(header);
    if (!isNaN(dateMs)) { const delta = dateMs - Date.now(); return delta > 0 ? delta : null; }
    return null;
  }
}

/**
 * Build a clear, non-misleading error message for a 401/403 from an LLM
 * endpoint. Provider auth failures (bad/expired/missing key, wrong base_url)
 * previously fell through to a generic `<Provider> API error (401): ...` which
 * sent users to platform.openai.com even when the request targeted a
 * DeepSeek / OpenAI-compatible base_url. This names the provider + endpoint and
 * points at gossipcat's key source (the OS keychain, not env vars). Issue #522.
 */
function authErrorMessage(provider: string, status: number, endpoint: string, body: string): string {
  return (
    `${provider} authentication failed (HTTP ${status}) for ${endpoint}: ` +
    `the API key was rejected. Verify the key for this provider/base_url — ` +
    `gossipcat resolves provider keys from the OS keychain (not environment ` +
    `variables). Response: ${body}`
  );
}

export interface LLMGenerateOptions {
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  webSearch?: boolean;  // Enable web search grounding (provider-specific)
}

export interface ILLMProvider {
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

export class AnthropicProvider implements ILLMProvider {
  private quota: QuotaTracker;
  private projectRoot?: string;
  private authSlot: string;
  constructor(private apiKey: string, private model: string, projectRoot?: string, authSlot?: string) {
    this.quota = new QuotaTracker('anthropic', projectRoot);
    this.projectRoot = projectRoot;
    this.authSlot = authSlot ?? 'anthropic';
  }

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystemMsgs.map(m => this.toAnthropicMessage(m)),
    };
    if (systemMsg) body.system = typeof systemMsg.content === 'string' ? systemMsg.content : '';
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    const anthropicTools: Array<Record<string, unknown>> = [];
    if (options?.tools?.length) {
      anthropicTools.push(...options.tools.map(t => ({
        name: t.name, description: t.description, input_schema: t.parameters,
      })));
    }
    if (options?.webSearch) {
      anthropicTools.push({ type: 'web_search_20250305', name: 'web_search' });
    }
    if (anthropicTools.length > 0) body.tools = anthropicTools;

    this.quota.checkBeforeRequest();
    const res = await fetchWithRetry503('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    }, 'anthropic');

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      if (res.status === 429) this.quota.handle429(res, body);
      if (res.status === 503) this.quota.handle503(res, body);
      if (res.status === 401 || res.status === 403) {
        recordAuthFailure(this.projectRoot, this.authSlot, res.status);
        throw new Error(authErrorMessage('Anthropic', res.status, 'https://api.anthropic.com/v1', body));
      }
      throw new Error(`Anthropic API error (${res.status}): ${body}`);
    }
    this.quota.onSuccess();
    clearAuthFailure(this.projectRoot, this.authSlot);
    const data = await res.json() as Record<string, unknown>;
    return this.parseAnthropicResponse(data);
  }

  private toAnthropicMessage(m: LLMMessage): Record<string, unknown> {
    // Multimodal content — translate ContentBlock[] to Anthropic format
    if (typeof m.content !== 'string') {
      return {
        role: m.role,
        content: m.content.map(block =>
          block.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } }
            : { type: 'text', text: block.text }
        ),
      };
    }
    // Tool result — guard content with typeof
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      };
    }
    // Assistant with tool calls — cast content to string
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content as string });
      for (const tc of m.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      return { role: 'assistant', content };
    }
    return { role: m.role, content: m.content };
  }

  private parseAnthropicResponse(data: Record<string, unknown>): LLMResponse {
    const content = data.content as Array<Record<string, unknown>>;
    let text = '';
    const toolCalls: LLMResponse['toolCalls'] = [];
    for (const block of content) {
      if (block.type === 'text') text += block.text as string;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id as string,
          name: block.name as string,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }
    const usage = data.usage as Record<string, number> | undefined;
    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : undefined,
    };
  }
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────

export class OpenAIProvider implements ILLMProvider {
  private quota: QuotaTracker;
  private baseUrl: string;
  private timeoutMs: number;
  private providerLabel: string;
  private projectRoot?: string;
  /** Keychain provider slot (deepseek / openclaw / openai) — the key the operator must fix. */
  private authProvider: string;
  constructor(
    private apiKey: string,
    private model: string,
    projectRoot?: string,
    baseUrl?: string,
    quotaSlot?: string,
    /**
     * HTTP request timeout in milliseconds. Defaults to 120s for openai.com
     * compatible endpoints. OpenClaw and other remote agentic LLMs that run
     * server-side tool chains (web_fetch, exec, etc.) need a longer ceiling
     * — pass 600_000 or higher when instantiating for those providers.
     */
    timeoutMs?: number,
    /**
     * Human-readable provider name used in the 401/403 auth-error message so a
     * first-class OpenAI-compatible provider (e.g. DeepSeek) names itself rather
     * than the generic "OpenAI-compatible". Defaults to "OpenAI-compatible". #522
     */
    providerLabel?: string,
    /**
     * Keychain SERVICE name (key_ref ?? provider) to name in the auth-failure
     * record, so gossip_status tells the operator the exact `gossipcat key set
     * <service>` to run. Distinct from the quota slot: rate-limit quota is keyed
     * per provider/endpoint (shared across agents on the same endpoint), while a
     * rejected key is per-agent credential. Defaults to the quota slot. #522
     */
    authSlot?: string,
  ) {
    this.baseUrl = (baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const quotaSlotResolved = quotaSlot ?? 'openai';
    this.quota = new QuotaTracker(quotaSlotResolved, projectRoot);
    this.authProvider = authSlot ?? quotaSlotResolved;
    this.timeoutMs = timeoutMs ?? 120_000;
    this.providerLabel = providerLabel ?? 'OpenAI-compatible';
    this.projectRoot = projectRoot;
  }

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => this.toOpenAIMessage(m)),
    };
    if (options?.maxTokens) body.max_tokens = options.maxTokens;
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.tools?.length) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    this.quota.checkBeforeRequest();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetchWithRetry503(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    }, 'openai');

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      if (res.status === 429) this.quota.handle429(res, body);
      if (res.status === 503) this.quota.handle503(res, body);
      // 401/403: auth/key failure for THIS endpoint. Surface a clear message
      // that names the configured base_url rather than the generic OpenAI host,
      // so DeepSeek / OpenAI-compatible users aren't sent to platform.openai.com.
      // Cooldown is deferred — handle429's quota state machine is keyed to
      // rate-limit semantics; a wrong key won't fix itself by waiting, so a
      // clear, fail-fast message is the correct behavior here (issue #522).
      if (res.status === 401 || res.status === 403) {
        recordAuthFailure(this.projectRoot, this.authProvider, res.status);
        throw new Error(authErrorMessage(this.providerLabel, res.status, this.baseUrl, body));
      }
      throw new Error(`OpenAI API error (${res.status}): ${body}`);
    }
    this.quota.onSuccess();
    clearAuthFailure(this.projectRoot, this.authProvider);
    const data = await res.json() as Record<string, unknown>;
    return this.parseOpenAIResponse(data);
  }

  private toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
    if (typeof m.content !== 'string') {
      return {
        role: m.role,
        content: m.content.map(block =>
          block.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
            : { type: 'text', text: block.text }
        ),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), tool_call_id: m.toolCallId };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant', content: (m.content as string) || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  }

  private parseOpenAIResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>>;
    if (!choices?.length) throw new Error(`LLM returned no choices: ${JSON.stringify(data)}`);
    const msg = choices[0].message as Record<string, unknown> | undefined;
    if (!msg) throw new Error(`LLM choice missing message object: ${JSON.stringify(choices[0])}`);
    const toolCalls: LLMResponse['toolCalls'] = [];
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, string>;
        toolCalls.push({ id: tc.id as string, name: fn.name, arguments: JSON.parse(fn.arguments) });
      }
    }
    const usage = data.usage as Record<string, number> | undefined;
    return {
      // #522: deepseek-reasoner returns its answer in `reasoning_content`,
      // sometimes alongside an empty-string `content`. Use `||` (NOT `??`) so an
      // empty-string content falls through to reasoning_content — `"" ?? x` keeps
      // the empty string and drops the answer.
      text: (msg.content || msg.reasoning_content || '') as string,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : undefined,
    };
  }
}

// ─── Google Gemini ───────────────────────────────────────────────────────────

export class GeminiProvider implements ILLMProvider {
  private quota: QuotaTracker;
  private projectRoot?: string;
  private authSlot: string;

  constructor(private apiKey: string, private model: string, projectRoot?: string, authSlot?: string) {
    this.quota = new QuotaTracker('google', projectRoot);
    this.projectRoot = projectRoot;
    this.authSlot = authSlot ?? 'google';
  }

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const contents = messages.filter(m => m.role !== 'system').map(m => this.toGeminiMessage(m));
    const systemMsg = messages.find(m => m.role === 'system');
    const body: Record<string, unknown> = { contents };
    if (systemMsg) body.systemInstruction = { parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : '' }] };
    if (options?.temperature !== undefined) {
      body.generationConfig = { temperature: options.temperature, maxOutputTokens: options?.maxTokens ?? 8192 };
    }

    // Gemini API: google_search and functionDeclarations CANNOT be combined.
    // If webSearch is enabled, use google_search only (worker agents call
    // their tools via relay RPC, not Gemini function calling).
    // If webSearch is not enabled, use functionDeclarations for native tool calls.
    const toolMode = options?.webSearch ? 'google_search' : options?.tools?.length ? `functionDeclarations(${options.tools.length})` : 'none';
    if (options?.webSearch) {
      body.tools = [{ google_search: {} }];
    } else if (options?.tools?.length) {
      body.tools = [{
        functionDeclarations: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    this.quota.checkBeforeRequest();

    if (process.env.GOSSIP_DEBUG) _log('Gemini', `${this.model} — ${messages.length} messages, tools=${toolMode}`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    // 5-minute per-call timeout. gemini-tester / gemini-reviewer run agentic
    // loops where a single big-context turn (refactor + multi-test plan) can
    // exceed 120s wall-clock. Matches the 600s budget given to openclaw and
    // the 300_000 default for gossip_dispatch write tasks.
    const res = await fetchWithRetry503(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    }, 'google');

    if (!res.ok) {
      const errBody = (await res.text()).slice(0, 200);
      if (res.status === 429) this.quota.handle429(res, errBody);
      if (res.status === 503) this.quota.handle503(res, errBody);
      if (res.status === 401 || res.status === 403) {
        recordAuthFailure(this.projectRoot, this.authSlot, res.status);
        throw new Error(authErrorMessage('Google Gemini', res.status, 'https://generativelanguage.googleapis.com/v1beta', errBody));
      }
      throw new Error(`Gemini API error (${res.status}): ${errBody}`);
    }
    this.quota.onSuccess();
    clearAuthFailure(this.projectRoot, this.authSlot);
    const data = await res.json() as Record<string, unknown>;
    const result = this.parseGeminiResponse(data);
    if (process.env.GOSSIP_DEBUG) _log('Gemini', `→ text=${result.text?.length ?? 0}chars, toolCalls=${result.toolCalls?.length ?? 0}${result.toolCalls?.length ? ` [${result.toolCalls.map(tc => tc.name).join(', ')}]` : ''}, tokens=${result.usage?.inputTokens ?? '?'}/${result.usage?.outputTokens ?? '?'}`);
    return result;
  }

  private toGeminiMessage(m: LLMMessage): Record<string, unknown> {
    // Tool result → functionResponse part
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: [{ functionResponse: { name: m.name || 'unknown', response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) } } }],
      };
    }
    // Assistant with tool calls → model with functionCall parts
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: Record<string, unknown>[] = [];
      if (m.content && typeof m.content === 'string' && m.content.trim()) {
        parts.push({ text: m.content });
      }
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      return { role: 'model', parts };
    }
    // Multimodal content
    if (typeof m.content !== 'string') {
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: m.content.map(block =>
          block.type === 'image'
            ? { inlineData: { mimeType: block.mediaType, data: block.data } }
            : { text: block.text }
        ),
      };
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  }

  private parseGeminiResponse(data: Record<string, unknown>): LLMResponse {
    const candidates = data.candidates as Array<Record<string, unknown>>;
    if (!candidates?.length) {
      const blockReason = (data as any).promptFeedback?.blockReason;
      const safetyRatings = (data as any).promptFeedback?.safetyRatings;
      const details = blockReason ? `blocked: ${blockReason}` : 'no candidates returned';
      _log('GeminiProvider', `Empty response — ${details}${safetyRatings ? ` safety=${JSON.stringify(safetyRatings)}` : ''}`);
      return { text: `[No response from Gemini: ${details}]` };
    }
    const candidate = candidates[0];
    const finishReason = candidate.finishReason as string | undefined;
    // STOP = normal, MAX_TOKENS = truncated, tool call reasons = function calling (expected)
    const expectedReasons = ['STOP', 'MAX_TOKENS', 'TOOL_CALL', 'UNEXPECTED_TOOL_CALL'];
    if (finishReason && !expectedReasons.includes(finishReason)) {
      _log('GeminiProvider', `Unusual finishReason: ${finishReason}`);
    }
    const content = candidate.content as Record<string, unknown> | undefined;
    const parts = (content?.parts || []) as Array<Record<string, unknown>>;
    if (!parts?.length) {
      // UNEXPECTED_TOOL_CALL: Gemini tried to call a function but the call was malformed.
      // The function call data may be in candidate.content.functionCall or similar.
      // Return placeholder; worker-agent.ts retries once on placeholder match, then surfaces the diagnostic.
      if (finishReason !== 'SAFETY') {
        _log('GeminiProvider', `Empty response parts (finishReason: ${finishReason || 'unknown'}). Returning empty to trigger retry.`);
      }
      if (finishReason === 'SAFETY') {
        _log('GeminiProvider', 'Response blocked by safety filter');
      }
      return { text: finishReason === 'SAFETY'
        ? '[Response blocked by Gemini safety filter]'
        : `[No response from Gemini: malformed_function_call finishReason=${finishReason ?? 'unknown'}]` };
    }

    const textParts: string[] = [];
    const toolCalls: LLMResponse['toolCalls'] = [];

    for (const part of parts) {
      if (part.text) {
        textParts.push(part.text as string);
      }
      if (part.functionCall) {
        const fc = part.functionCall as { name: string; args: Record<string, unknown>; id?: string };
        toolCalls.push({
          id: fc.id || randomUUID().slice(0, 12),
          name: fc.name,
          arguments: fc.args || {},
        });
      }
    }

    const usage = data.usageMetadata as {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    } | undefined;

    return {
      text: textParts.join(''),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage?.promptTokenCount != null ? {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
      } : undefined,
    };
  }
}

// ─── Ollama (local) ─────────────────────────────────────────────────────────

export class OllamaProvider implements ILLMProvider {
  constructor(private model: string, private baseUrl: string = 'http://localhost:11434') {}

  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => {
        if (typeof m.content !== 'string') {
          const texts = m.content.filter(b => b.type === 'text').map(b => (b as any).text);
          const images = m.content.filter(b => b.type === 'image').map(b => (b as any).data);
          return {
            role: m.role === 'tool' ? 'user' : m.role,
            content: texts.join(' ') || '',
            ...(images.length ? { images } : {}),
          };
        }
        return { role: m.role === 'tool' ? 'user' : m.role, content: m.content };
      }),
      stream: false,
    };
    if (options?.temperature !== undefined) body.options = { temperature: options.temperature };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Ollama API error (${res.status}): ${body}`);
    }
    const data = await res.json() as Record<string, unknown>;
    const msg = data.message as Record<string, string>;
    return { text: msg.content };
  }
}

// ─── Null provider (no API key — features degrade gracefully) ──────────────

class NullProvider implements ILLMProvider {
  async generate(): Promise<LLMResponse> {
    return { text: '' };
  }
}

/**
 * A provider that rejects every generate() call with a fixed diagnostic. Used
 * for the pre-flight missing-key case (issue #522): a key-requiring agent built
 * with no configured key gets one of these instead of crashing construction or
 * issuing an empty-Bearer request that returns a misleading 401. The rejection
 * surfaces as a normal task failure via gossip_collect / gossip_progress.
 */
class DegradedProvider implements ILLMProvider {
  constructor(private readonly reason: string) {}
  async generate(): Promise<LLMResponse> {
    throw new Error(this.reason);
  }
}

/**
 * Providers that require an API key to function. `local` (Ollama) and `none`
 * (NullProvider) do not. Exported for the pre-flight key check at the worker
 * construction site (main-agent.ts).
 */
export const KEY_REQUIRING_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'openclaw', 'google'] as const;

/**
 * Build a provider for an agent, downgrading to a {@link DegradedProvider} when
 * a key-requiring provider has no key configured. Prefer this over
 * `createProvider` at agent-construction sites so a missing key fails the TASK
 * with a clear message rather than crashing construction or sending an
 * empty-Bearer request. Issue #522.
 */
export function createProviderForAgent(
  agentId: string,
  provider: string,
  model: string,
  apiKey: string | undefined,
  baseUrl?: string,
  projectRoot?: string,
  keyRef?: string,
): ILLMProvider {
  if ((KEY_REQUIRING_PROVIDERS as readonly string[]).includes(provider) && !apiKey) {
    // Name the keychain SERVICE the resolver tried (key_ref ?? provider) so a
    // missing per-agent key is actionable — the operator knows exactly which
    // service to store. Service names are safe to log; never the key value. #522
    const service = keyRef ?? provider;
    return new DegradedProvider(
      `no API key configured for agent "${agentId}" (provider ${provider}, ` +
      `base_url ${baseUrl ?? 'default'}); set the key for keychain service "${service}"`,
    );
  }
  // Auth-failure slot = the keychain SERVICE the operator must fix (key_ref ??
  // provider), so gossip_status names the right `gossipcat key set <service>`.
  // Distinct from the quota slot (per-endpoint rate-limit state). #522
  return createProvider(provider, model, apiKey, projectRoot, baseUrl, keyRef ?? provider);
}

/**
 * Pure async helper: resolves the per-agent keychain service (key_ref ?? provider),
 * fetches the key via the injected `getKey` callback, then delegates to
 * {@link createProviderForAgent}. Extracted from the doBoot inline block so the
 * key-resolution + provider-construction path can be unit-tested without a
 * full MCP-boot harness. #522
 *
 * @param ac  Minimal agent config shape — same fields used at every construction site.
 * @param getKey  Injected key lookup (e.g. `(s) => ctx.keychain.getKey(s)`); returns
 *                `null` when the service has no stored key.
 */
export async function resolveAgentProvider(
  ac: { id: string; provider: string; model: string; base_url?: string; key_ref?: string },
  getKey: (service: string) => Promise<string | null>,
): Promise<ILLMProvider> {
  const keyService = ac.key_ref ?? ac.provider;
  const key = await getKey(keyService);
  return createProviderForAgent(ac.id, ac.provider, ac.model, key ?? undefined, ac.base_url, undefined, ac.key_ref);
}

// ─── Factory ────────────────────────────────────────────────────────────────

// Runtime-side mirror of the providers the switch below knows how to build.
// Keep in sync with the `case` arms in createProvider — the parity test in
// tests/cli/config.test.ts asserts this matches VALID_MAIN_PROVIDERS in
// apps/cli/src/config.ts so a provider can never pass schema validation but
// fail at runtime (or vice versa).
export const CREATE_PROVIDER_CASES = ['anthropic', 'openai', 'deepseek', 'openclaw', 'google', 'local', 'none'] as const;

export function createProvider(provider: string, model: string, apiKey?: string, projectRoot?: string, baseUrl?: string, authSlot?: string): ILLMProvider {
  switch (provider) {
    case 'anthropic': return new AnthropicProvider(apiKey!, model, projectRoot, authSlot);
    case 'openai': return new OpenAIProvider(apiKey ?? '', model, projectRoot, baseUrl, baseUrl ? `openai:${baseUrl}` : undefined, undefined, undefined, authSlot);
    // DeepSeek is OpenAI-wire-compatible — reuse OpenAIProvider. Default the
    // base_url to api.deepseek.com/v1 (an explicit base_url still overrides),
    // give it a 'deepseek' quota slot, and a 'DeepSeek' label so 401/403 auth
    // errors name DeepSeek instead of the generic "OpenAI-compatible". #522.
    // 600s timeout (like openclaw): deepseek-reasoner streams long reasoning_content
    // and per-turn latency was observed at 60-74s — the 120s default terminates it.
    case 'deepseek': return new OpenAIProvider(
      apiKey ?? '', model, projectRoot,
      baseUrl ?? 'https://api.deepseek.com/v1',
      'deepseek', 600_000, 'DeepSeek', authSlot,
    );
    // OpenClaw is a remote agentic LLM with its own server-side tool chain
    // (web_fetch, exec, browser, etc.). Its wallclock regularly exceeds the
    // 120s default because it's doing Claude-like agentic work per request
    // — two timeouts this session (task 2b426ef6 at 100.9s, task 53005181
    // hit the 120s cap on a URL-fetching review). Give it 10 minutes.
    case 'openclaw': return new OpenAIProvider(apiKey ?? '', model, projectRoot, baseUrl ?? 'http://127.0.0.1:18789/v1', 'openclaw', 600_000, undefined, authSlot);
    case 'google': return new GeminiProvider(apiKey!, model, projectRoot, authSlot);
    case 'local': return new OllamaProvider(model);
    case 'none': return new NullProvider();
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
