/**
 * signal-helpers.ts — typed helpers for each signal-emission category.
 *
 * Layer 2 of the signal-pipeline parity defence (spec:
 * docs/specs/2026-04-19-l2-signal-writer-visibility.md).
 *
 * IMPORTANT: `emitCompletionSignals` (task_completed / task_tool_turns /
 * format_compliance / finding_dropped_format) already exists in
 * packages/orchestrator/src/completion-signals.ts and is NOT duplicated here.
 * Use that helper for type='meta' task-lifecycle signals.
 *
 * Every helper in this file follows the same contract:
 *  - try/catch wraps ALL logic — helpers never throw to callers.
 *  - On error, a single line is written to process.stderr with the prefix
 *    `[gossipcat] <helperName> failed: <message>`.
 *  - No `as any` casts — WRITER_INTERNAL resolves the Symbol key type-safely.
 *  - A mandatory guard asserts `signals.every(s => s.type === '<X>')` before
 *    writing. Violation throws inside the try; outer catch logs and no signal
 *    is written. (consensus fb3ea8fc-6e674462:f17/f18)
 */

import { PerformanceWriter } from './performance-writer';
import { WRITER_INTERNAL } from './_writer-internal';
import type { PerformanceSignal } from './consensus-types';

// ── Helper 1: emitConsensusSignals ────────────────────────────────────────────
//
// Owns all type='consensus' signals from consensus-coordinator.ts, collect.ts,
// native-tasks.ts (lines 78/237), relay-cross-review.ts, and mcp-server-sdk.ts
// (lines 2353/2446/2664).
//
// Signal names covered: agreement, disagreement, unverified, unique_confirmed,
// unique_unconfirmed, new_finding, hallucination_caught, category_confirmed,
// consensus_verified, signal_retracted, consensus_round_retracted, task_timeout,
// task_empty, severity_miscalibrated (after Step 1a allowlist fix).
//
// Expected callers (PR B wiring):
//   consensus-coordinator.ts:113,133
//   relay-cross-review.ts:41,308
//   collect.ts:201,746
//   mcp-server-sdk.ts:2353,2446,2664
//   native-tasks.ts:78,237

export function emitConsensusSignals(
  projectRoot: string,
  signals: PerformanceSignal[],
): void {
  try {
    if (signals.length === 0) return;
    if (!signals.every(s => s.type === 'consensus')) {
      throw new Error(
        `emitConsensusSignals: all signals must have type='consensus'; received ` +
        `[${[...new Set(signals.map(s => s.type))].join(', ')}]`
      );
    }
    const writer = new PerformanceWriter(projectRoot);
    writer[WRITER_INTERNAL].appendSignals(signals, 'signal-helpers-consensus');
  } catch (err) {
    process.stderr.write(`[gossipcat] emitConsensusSignals failed: ${(err as Error).message}\n`);
  }
}

// ── Helper 2: emitSandboxSignals ──────────────────────────────────────────────
//
// Thin single-signal wrapper on the consensus allowlist, kept separate from
// emitConsensusSignals for log grep-ability ("boundary violation" is a distinct
// operational concern) and for future per-topic validation (e.g., must include
// filePath). Signals must be type='consensus'.
//
// Signal names covered: worktree_boundary_escape, sandbox_trust_violation.
//
// Expected callers (PR B wiring):
//   apps/cli/src/sandbox.ts:511,1281

export function emitSandboxSignals(
  projectRoot: string,
  signal: PerformanceSignal,
): void {
  try {
    const writer = new PerformanceWriter(projectRoot);
    writer[WRITER_INTERNAL].appendSignal(signal, 'signal-helpers-sandbox');
  } catch (err) {
    process.stderr.write(`[gossipcat] emitSandboxSignals failed: ${(err as Error).message}\n`);
  }
}

// ── Helper 3: emitImplSignals ─────────────────────────────────────────────────
//
// Owns all type='impl' signals. Mandatory guard asserts type='impl' on every
// signal in the batch.
//
// Signal names covered: impl_test_pass, impl_test_fail, impl_peer_approved,
// impl_peer_rejected.
//
// Expected callers (PR B wiring):
//   apps/cli/src/handlers/native-tasks.ts:359

export function emitImplSignals(
  projectRoot: string,
  signals: PerformanceSignal[],
): void {
  try {
    if (signals.length === 0) return;
    if (!signals.every(s => s.type === 'impl')) {
      throw new Error(
        `emitImplSignals: all signals must have type='impl'; received ` +
        `[${[...new Set(signals.map(s => s.type))].join(', ')}]`
      );
    }
    const writer = new PerformanceWriter(projectRoot);
    writer[WRITER_INTERNAL].appendSignals(signals, 'signal-helpers-impl');
  } catch (err) {
    process.stderr.write(`[gossipcat] emitImplSignals failed: ${(err as Error).message}\n`);
  }
}

// ── Helper 4: emitScoringAdjustmentSignals ────────────────────────────────────
//
// Thin single-signal wrapper for post-hoc scoring corrections. Kept separate
// from emitConsensusSignals for log grep-ability and future per-topic
// validation. Depends on Step 1a having added 'severity_miscalibrated' to
// VALID_CONSENSUS_SIGNALS — without that fix this helper would route a
// silently-dropped signal.
//
// Signal names covered: severity_miscalibrated.
//
// Expected callers (PR B wiring):
//   apps/cli/src/mcp-server-sdk.ts:2595

export function emitScoringAdjustmentSignals(
  projectRoot: string,
  signal: PerformanceSignal,
): void {
  try {
    const writer = new PerformanceWriter(projectRoot);
    writer[WRITER_INTERNAL].appendSignal(signal, 'signal-helpers-scoring');
  } catch (err) {
    process.stderr.write(`[gossipcat] emitScoringAdjustmentSignals failed: ${(err as Error).message}\n`);
  }
}

// ── Helper 5: emitPipelineSignals ─────────────────────────────────────────────
//
// Owns type='pipeline' instrumentation signals OUTSIDE completion-signals.ts.
// Note: finding_dropped_format (type='pipeline') stays in emitCompletionSignals
// for backward compatibility — only non-completion pipeline signals live here.
//
// Mandatory guard asserts type='pipeline' on every signal in the batch.
// (consensus fb3ea8fc-6e674462:n1 + f6 — skill-loader.ts:185,199 sites)
//
// Signal names covered: skill_injection_skipped (and future pipeline signals).
//
// Expected callers (PR A wiring — orchestrator-internal):
//   packages/orchestrator/src/skill-loader.ts:185,199

export function emitPipelineSignals(
  projectRoot: string,
  signals: PerformanceSignal[],
): void {
  try {
    if (signals.length === 0) return;
    if (!signals.every(s => s.type === 'pipeline')) {
      throw new Error(
        `emitPipelineSignals: all signals must have type='pipeline'; received ` +
        `[${[...new Set(signals.map(s => s.type))].join(', ')}]`
      );
    }
    const writer = new PerformanceWriter(projectRoot);
    writer[WRITER_INTERNAL].appendSignals(signals, 'signal-helpers-pipeline');
  } catch (err) {
    process.stderr.write(`[gossipcat] emitPipelineSignals failed: ${(err as Error).message}\n`);
  }
}
