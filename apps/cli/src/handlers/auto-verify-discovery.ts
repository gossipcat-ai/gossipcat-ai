/**
 * Auto-verify discovery — team-aware resolution of the verifier binding for
 * consensus auto-verify (spec
 * docs/superpowers/specs/2026-05-21-consensus-auto-verify-design.md).
 *
 * Returns a `VerifierBinding` describing HOW the cli should dispatch the
 * verifier (native two-phase shim vs. relay worker) — or `undefined` when no
 * suitable verifier exists. The engine treats `undefined` as misconfig at
 * flag-ON and emits a one-shot `auto_verify_skipped_misconfigured` signal.
 */
import type { AgentConfig } from '@gossip/orchestrator';

export type VerifierBinding =
  | { kind: 'native_utility'; agentId: string }
  | { kind: 'relay_worker'; agentId: string };

/**
 * Shared predicate used by BOTH the default discovery path and the override
 * path. Native agents (Claude Code subagents) always ship with `file_read`
 * and `file_grep`, so the predicate is just `native === true`. Relay agents
 * must self-declare the `verification` skill on their AgentConfig.skills
 * array to opt in.
 */
export function isVerifierSuitable(agent: AgentConfig): boolean {
  if (agent.native === true) return true;
  return Array.isArray(agent.skills) && agent.skills.includes('verification');
}

/**
 * Resolve a verifier binding from the team's AgentConfig list. `override` is
 * the value of `GOSSIP_CONSENSUS_AUTO_VERIFY_AGENT` (empty string = no
 * override). Returns `undefined` when:
 *   - override is set but the named agent doesn't exist in the team, OR
 *   - override is set but the named agent fails `isVerifierSuitable`, OR
 *   - team is empty, OR
 *   - team has no native and no `verification`-skilled relay agent.
 */
export function discoverVerifier(
  agents: AgentConfig[],
  override?: string,
): VerifierBinding | undefined {
  // Override path. Rev-6 defect 4: suitability check applies here too.
  if (override && override.length > 0) {
    const agent = agents.find(a => a.id === override);
    if (!agent) return undefined;
    if (!isVerifierSuitable(agent)) return undefined;
    return agent.native === true
      ? { kind: 'native_utility', agentId: override }
      : { kind: 'relay_worker', agentId: override };
  }

  // Default discovery: native first, then verification-skilled relay.
  const nativeVerifier = agents.find(a => a.native === true);
  if (nativeVerifier) {
    return { kind: 'native_utility', agentId: nativeVerifier.id };
  }
  const relayVerifier = agents.find(
    a => a.native !== true && Array.isArray(a.skills) && a.skills.includes('verification'),
  );
  if (relayVerifier) {
    return { kind: 'relay_worker', agentId: relayVerifier.id };
  }

  return undefined;
}
