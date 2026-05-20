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
//  (Phantom entries — registry key without a call site — caught at code-review time.)

export const RUNTIME_FLAG_REGISTRY = {
  GOSSIP_NATIVE_WORKTREE_MANAGED: {
    type: 'boolean' as const,
    default: '0',
    description:
      'Enable managed-worktree mode for native dispatches (Option A, spec 2026-05-20-native-worktree-isolation-fix.md)',
  },
} as const;

export type RuntimeFlagKey = keyof typeof RUNTIME_FLAG_REGISTRY;
export type RuntimeFlagSpec =
  | { type: 'boolean'; default: string; description: string }
  | { type: 'integer'; default: string; description: string; min: number; max: number }
  | { type: 'string'; default: string; description: string };
