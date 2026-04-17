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
