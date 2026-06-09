// packages/orchestrator/src/runtime-config-schema.ts
//
// Registry of all behavioral feature-gate flags managed by the runtime config
// store. Only GOSSIP_* keys are valid — the GOSSIP_* prefix filter in
// runtime-config.ts enforces this at read time.
//
// When adding a new flag:
//  1. Add an entry here.
//  2. Add a corresponding getRuntimeFlagBool/getRuntimeFlag call site in the
//     feature code.
//  3. Add tests to tests/orchestrator/runtime-config.test.ts.
//  (Phantom entries — registry key without a call site — are caught at code-
//   review time.)

export const RUNTIME_FLAG_REGISTRY = {
  /**
   * Master gate for the consensus auto-verify feature. When `'1'`, the
   * ConsensusEngine's `run()` dispatches a utility verifier against every
   * UNVERIFIED finding and stamps the result on `finding.autoVerify` before
   * `formatReport`. Default `'0'` (off) — operators opt in.
   * Spec: docs/superpowers/specs/2026-05-21-consensus-auto-verify-design.md.
   */
  GOSSIP_CONSENSUS_AUTO_VERIFY_UNVERIFIED: {
    type: 'boolean',
    default: '0',
    description: 'Enable consensus auto-verify of UNVERIFIED findings.',
  },
  /**
   * Operator override for the auto-verify verifier discovery. When set, the
   * cli `discoverVerifier(agents, override)` resolves to this agent_id instead
   * of the default native-then-relay priority order. Empty string = no
   * override. The named agent MUST pass `isVerifierSuitable` (native or
   * `verification` skill) or the round emits a `override_agent_unsuitable`
   * misconfig signal at runtime.
   */
  GOSSIP_CONSENSUS_AUTO_VERIFY_AGENT: {
    type: 'string',
    default: '',
    description: 'Operator override agent_id for consensus auto-verify discovery.',
  },
  /**
   * When '1', a detected worktree-isolation leak whose work was successfully
   * preserved to .gossip/recovery/<taskId>.patch is ALSO destructively
   * reverted from the parent checkout (git restore --source=HEAD). Default '0'
   * (preserve + report only) — a heuristic detector must not default to a
   * destructive op (issue #437, round 251e5ef6-d4d44ba2).
   */
  GOSSIP_WORKTREE_AUTO_REVERT: { type: 'boolean', default: '0', description: 'Destructively revert preserved isolation-leak paths from the parent checkout' },
} as const;

export type RuntimeFlagKey = keyof typeof RUNTIME_FLAG_REGISTRY;
export type RuntimeFlagSpec =
  | { type: 'boolean'; default: string; description: string; deprecated?: true }
  | { type: 'integer'; default: string; description: string; min: number; max: number; deprecated?: true }
  | { type: 'string'; default: string; description: string; deprecated?: true };
