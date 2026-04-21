/**
 * COMPLETION_SIGNAL_ALLOWLIST — the committed set of signal types that
 * emitCompletionSignals (./completion-signals.ts) is permitted to emit.
 *
 * This file is a Layer 1 drift guard. The parity test at
 * tests/orchestrator/completion-signals-parity.test.ts parses the helper
 * source and fails when the two sets diverge.
 *
 * ── Adding a new signal ──────────────────────────────────────────────────
 *  (a) Add the emission to packages/orchestrator/src/completion-signals.ts.
 *  (b) Add the signal name below.
 *  (c) Run `npm test` (or `npx jest tests/orchestrator/completion-signals-parity`)
 *      to confirm the parity test passes.
 *
 * ── Removing a signal ────────────────────────────────────────────────────
 * Mirror image: remove from helper, prune here, re-run test.
 */
export const COMPLETION_SIGNAL_ALLOWLIST: readonly string[] = [
  'task_completed',
  'task_tool_turns',
  'format_compliance',
  'finding_dropped_format',
  'citation_fabricated',
] as const;

/**
 * EMISSION_PATHS — closed enum of code regions permitted to write into
 * `agent-performance.jsonl` via `PerformanceWriter.appendSignal(s)`.
 *
 * Layer 3 drift detector (`pipeline-drift-detector.ts`) tags every row with
 * the caller's identity (stamped as `_emission_path` on each serialised row)
 * and fires a drift event when an allowlisted completion-signal name appears
 * on a non-helper path, or when rows land with `_emission_path === 'unknown'`.
 *
 * The parity test `completion-signals-parity.test.ts` asserts every
 * `appendSignal` or `appendSignals` call site in `packages/orchestrator/src/**`
 * and `apps/cli/src/**` passes a second argument drawn from this array. To
 * add a new path, extend this array AND the corresponding call site in the
 * same PR — see the spec
 * `docs/specs/2026-04-19-l3-signal-pipeline-drift-detector.md`.
 *
 * The TS union `EmissionPath` is derived via `typeof EMISSION_PATHS[number]`,
 * so the runtime array and the compile-time type share a single source of
 * truth — there is no mirror to drift.
 */
export const EMISSION_PATHS = [
  'completion-signals-helper',
  'consensus-coordinator',
  'consensus-engine',
  'dispatch-pipeline',
  'native-tasks',
  'relay-cross-review',
  'collect-handler',
  'sandbox-boundary',
  'sandbox-trust',
  'mcp-server-signals',
  'mcp-server-bulk',
  'mcp-server-impl',
  // L2: typed signal helpers (signal-helpers.ts). Each helper function maps to
  // one of these paths so the L3 drift detector can distinguish helper-routed
  // emissions from direct bypass writes.
  'signal-helpers-consensus',
  'signal-helpers-sandbox',
  'signal-helpers-impl',
  'signal-helpers-scoring',
  'signal-helpers-pipeline',
  'unknown',
] as const;

export type EmissionPath = typeof EMISSION_PATHS[number];
