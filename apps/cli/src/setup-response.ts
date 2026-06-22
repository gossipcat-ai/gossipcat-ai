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
 * - `main_agent` is always overwritten from the request.
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
