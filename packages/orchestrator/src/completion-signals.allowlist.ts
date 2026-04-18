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
] as const;
