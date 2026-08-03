/**
 * Pure helpers for building the user-facing gossip_setup response. Extracted
 * so the dashboard-refresh advisory (issue #96) can be unit-tested without
 * booting the entire MCP server.
 *
 * The advisory covers three observable failure modes from issue #96:
 *  1. setAgentConfigs throwing (syncResult.ok === false) → user sees empty
 *     dashboard but gets no feedback in the gossip_setup response.
 *  2. Degraded-mode boot (no config at boot time) → dashboard was initialized
 *     with 0 agents and needs the next poll tick to pick up new ones.
 *  3. Success case → show the agent count so the user has a confirmation
 *     anchor when cross-referencing with the Team page.
 */

import { VALID_MAIN_PROVIDERS } from './config';

export interface SyncResultSummary {
  ok: boolean;
  mergedAgentCount: number;
  error?: string;
}

export interface DashboardAdvisoryInput {
  syncResult: SyncResultSummary | null;
  bootedInDegradedMode: boolean;
}

/**
 * Build the dashboard-refresh advisory lines appended to the gossip_setup
 * response. Returns an array of lines (possibly empty). Callers prepend a
 * blank line themselves — keeps this helper free of formatting coupling.
 */
export function buildDashboardAdvisory(input: DashboardAdvisoryInput): string[] {
  const { syncResult, bootedInDegradedMode } = input;
  const out: string[] = [];

  if (!syncResult) {
    // syncWorkersViaKeychain never populated lastSyncResult — either it threw
    // before reaching the result-write, or the caller skipped the sync path.
    out.push('⚠ Dashboard refresh status unknown. Run `/mcp` reconnect to see agents.');
    return out;
  }

  if (syncResult.ok) {
    out.push(`Dashboard: refreshed with ${syncResult.mergedAgentCount} agent${syncResult.mergedAgentCount === 1 ? '' : 's'}.`);
  } else {
    const reason = syncResult.error ? `: ${syncResult.error}` : '';
    out.push(`⚠ Dashboard refresh failed${reason}. Run \`/mcp\` reconnect to see agents.`);
  }

  if (bootedInDegradedMode) {
    out.push('Note: dashboard may take up to 10s to reflect new agents (relay booted before config existed). If it stays empty, `/mcp` reconnect populates it.');
  }

  return out;
}

/**
 * Build the rebuilt gossipcat config for gossip_setup, preserving unknown
 * top-level fields (f16). Extracted as a pure function so the field-preservation
 * invariant is unit-testable without booting the MCP server.
 *
 * - `existingConfig` is spread first so any top-level field we don't manage
 *   (consensus.siblingRoots, autoDiscoverWorktrees, orchestratorOwnedGlobs,
 *   utility_model, …) survives a re-run in BOTH merge and replace modes.
 * - `main_agent` is always overwritten from the value the caller passes in.
 *   The caller resolves that value with `resolveMainAgent` first (#724), so an
 *   omitted `main_provider` preserves the on-disk orchestrator instead of being
 *   stomped by a schema default.
 * - `agents` is `{ ...existingAgents, ...newAgents }`. The caller passes an
 *   empty `existingAgents` in replace mode (team replaced) and the prior agent
 *   map in merge mode. Either way, OTHER top-level fields are preserved —
 *   replace replaces the team, not the whole top-level config.
 */
export interface MergedSetupConfig {
  main_agent: { provider: string; model: string };
  agents: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export function mergeSetupConfig(input: {
  existingConfig: Record<string, unknown>;
  mainAgent: { provider: string; model: string };
  existingAgents: Record<string, Record<string, unknown>>;
  newAgents: Record<string, Record<string, unknown>>;
}): MergedSetupConfig {
  const { existingConfig, mainAgent, existingAgents, newAgents } = input;
  return {
    ...existingConfig,
    main_agent: { provider: mainAgent.provider, model: mainAgent.model },
    agents: { ...existingAgents, ...newAgents },
  };
}

/**
 * The zero-config orchestrator state: no API LLM, host classifies natively
 * (Claude Code / Cursor). Used when a fresh setup has nothing to preserve.
 */
export const NATIVE_MAIN_AGENT: { provider: string; model: string } = { provider: 'none', model: 'none' };

export interface MainAgentSelection {
  provider: string;
  model: string;
  /** Set when a half-specified request pair was ignored — surfaced to the user. */
  warning?: string;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read a usable `main_agent` out of an existing config. Returns null when the
 * field is absent, malformed, or names a provider validateConfig would reject —
 * a corrupt orchestrator entry must not be preserved, otherwise gossip_setup
 * would become unable to repair the very config it wrote.
 */
function readExistingMainAgent(
  existingConfig: Record<string, unknown> | null | undefined,
): { provider: string; model: string } | null {
  const raw = (existingConfig ?? {})['main_agent'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const provider = trimmed((raw as Record<string, unknown>).provider);
  const model = trimmed((raw as Record<string, unknown>).model);
  if (!provider || !model) return null;
  if (!VALID_MAIN_PROVIDERS.includes(provider)) return null;
  return { provider, model };
}

/**
 * Resolve the orchestrator LLM for a gossip_setup run (#724).
 *
 * Before this existed, `main_provider` / `main_model` carried Zod defaults of
 * google / gemini-2.5-pro, so ANY gossip_setup call that omitted them silently
 * reset a deliberately-configured `main_agent` (e.g. provider "none" for native
 * orchestration) back to Google.
 *
 * Resolution order:
 *  1. An explicit `provider` (with `model`) always wins.
 *  2. Otherwise the existing on-disk `main_agent` is preserved — in BOTH merge
 *     and replace modes. Replace replaces the team, not the orchestrator choice,
 *     consistent with the f16 top-level field-preservation invariant above.
 *  3. Otherwise (fresh setup, nothing to preserve) → `none`/`none`, the
 *     documented zero-config native-orchestration state.
 *
 * The pair is atomic: only an explicit `provider` activates the request. A lone
 * `model` is ignored (it cannot be attributed to a provider), and a lone
 * `provider` is honored only when a model can be sourced without guessing —
 * either the preserved entry already uses that same provider, or the provider is
 * "none" (whose model is "none"). Anything else keeps the preserved/default pair
 * and reports a warning rather than writing a provider/model mismatch.
 */
export function resolveMainAgent(
  requested: { provider?: string; model?: string },
  existingConfig: Record<string, unknown> | null | undefined,
): MainAgentSelection {
  const reqProvider = trimmed(requested.provider);
  const reqModel = trimmed(requested.model);
  const preserved = readExistingMainAgent(existingConfig);
  const fallback = preserved ?? { ...NATIVE_MAIN_AGENT };

  if (reqProvider && reqModel) return { provider: reqProvider, model: reqModel };

  if (reqProvider) {
    if (preserved && preserved.provider === reqProvider) {
      return { provider: reqProvider, model: preserved.model };
    }
    if (reqProvider === NATIVE_MAIN_AGENT.provider) return { ...NATIVE_MAIN_AGENT };
    return {
      ...fallback,
      warning:
        `main_provider "${reqProvider}" ignored — main_model is required when switching the orchestrator provider. ` +
        `Kept main_agent ${fallback.provider}/${fallback.model}.`,
    };
  }

  if (reqModel && reqModel !== fallback.model) {
    return {
      ...fallback,
      warning:
        `main_model "${reqModel}" ignored — main_provider must be passed explicitly to change the orchestrator LLM. ` +
        `Kept main_agent ${fallback.provider}/${fallback.model}.`,
    };
  }

  return fallback;
}

/**
 * Build the gossip_status agent-list line shown when .gossip/config.json fails
 * to load/validate (f19). Keeps the exact fix-hint wording in one testable place
 * so a regression in the message format is caught by a unit test.
 */
export function buildMalformedConfigHint(configPath: string, message: string): string {
  return `⚠️ config.json is malformed: ${message} — fix or delete ${configPath}`;
}

/** A gossip_setup agent file write deferred until AFTER validateConfig passes. */
export interface StagedAgentFileWrite {
  /** Directory to mkdir (recursive) before writing the file. */
  dir: string;
  /** Absolute path of the file to write. */
  path: string;
  /** File contents. */
  content: string;
}

/**
 * Flush staged agent file writes to disk (loop-transactionality v2). Called
 * only on the gossip_setup success path, AFTER validateConfig accepts the config,
 * so a validation failure leaves zero orphan agent files on disk — neither
 * native .claude/agents/<id>.md nor custom .gossip/agents/<id>/instructions.md.
 * Each file's dir is created (recursive) immediately before its write.
 */
export function flushStagedAgentFileWrites(
  writes: ReadonlyArray<StagedAgentFileWrite>,
  fs: {
    mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
    writeFileSync: (path: string, content: string, enc: 'utf-8') => void;
  },
): void {
  for (const w of writes) {
    fs.mkdirSync(w.dir, { recursive: true });
    fs.writeFileSync(w.path, w.content, 'utf-8');
  }
}
