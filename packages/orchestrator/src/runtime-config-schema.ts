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
//   review time, EXCEPT for entries explicitly marked @deprecated in their
//   JSDoc, which are retained as tombstones for test-suite exemplars and
//   audit-log continuity.)

export const RUNTIME_FLAG_REGISTRY = {
  /**
   * @deprecated 2026-05-21 — no-op tombstone. Option A (managed-worktree
   * structural fix, PR #431) was reverted after discovery that Claude Code
   * resets cwd between tool invocations, making the load-bearing `cd` line
   * unreachable. Retained as the runtime-config test exemplar (see
   * tests/orchestrator/runtime-config.test.ts). Setting it has no runtime
   * effect; `gossip_config set` surfaces a deprecation warning in the ack.
   */
  GOSSIP_NATIVE_WORKTREE_MANAGED: {
    type: 'boolean' as const,
    default: '0',
    description: 'No-op tombstone. Retained as runtime-config test exemplar.',
    deprecated: true as const,
  },
} as const;

export type RuntimeFlagKey = keyof typeof RUNTIME_FLAG_REGISTRY;
export type RuntimeFlagSpec =
  | { type: 'boolean'; default: string; description: string; deprecated?: true }
  | { type: 'integer'; default: string; description: string; min: number; max: number; deprecated?: true }
  | { type: 'string'; default: string; description: string; deprecated?: true };
