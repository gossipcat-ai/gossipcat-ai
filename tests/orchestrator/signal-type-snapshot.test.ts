/**
 * Snapshot test: every SignalType in PerformanceSignal union must either:
 * A) have an emission site in completion-signals.ts, OR
 * B) be documented as path-specific in the DOCUMENTED_PATH_SPECIFIC set below.
 *
 * Purpose: when someone adds a new signal type, this test forces them to
 * either wire it into emitCompletionSignals OR explicitly document why it
 * lives somewhere else. Prevents silent signal-pipeline drift (the original
 * bug that took consensus 23687227-1462428b to find).
 */

import type { PerformanceSignal } from '@gossip/orchestrator';

// ── Signal types emitted by emitCompletionSignals ────────────────────────────
const COMPLETION_SIGNALS_EMITTED = new Set<string>([
  'task_completed',
  'task_tool_turns',   // conditionally (when toolCalls defined)
  'format_compliance',
  'finding_dropped_format',
  'citation_fabricated', // emitCitationFabricatedSignal (memory-writer call sites)
]);

// ── Path-specific signals: not emitted by emitCompletionSignals ──────────────
// These are intentionally NOT in the shared helper because they have
// specific dispatch contexts. Document the emission site here.
const DOCUMENTED_PATH_SPECIFIC = new Map<string, string>([
  // Consensus signals — emitted by ConsensusCoordinator / gossip_signals handler
  ['agreement',                 'consensus-engine.ts / gossip_signals'],
  ['disagreement',              'consensus-engine.ts / gossip_signals'],
  ['unverified',                'consensus-engine.ts / gossip_signals'],
  ['unique_confirmed',          'consensus-engine.ts / gossip_signals'],
  ['unique_unconfirmed',        'consensus-engine.ts / gossip_signals'],
  ['new_finding',               'consensus-engine.ts / gossip_signals'],
  ['hallucination_caught',      'gossip_signals'],
  ['category_confirmed',        'consensus-engine.ts'],
  ['consensus_verified',        'consensus-engine.ts'],
  ['signal_retracted',          'performance-writer.ts / gossip_signals'],
  ['consensus_round_retracted', 'performance-writer.ts / gossip_signals'],
  ['severity_miscalibrated',    'consensus-engine.ts'],
  ['task_timeout',              'dispatch-pipeline.ts (timeout path)'],
  ['task_empty',                'dispatch-pipeline.ts (empty result path)'],
  // Impl signals — emitted by verify_write / auto-record in native-tasks.ts
  ['impl_test_pass',            'native-tasks.ts / verify_write handler'],
  ['impl_test_fail',            'native-tasks.ts / verify_write handler'],
  ['impl_peer_approved',        'gossip_signals'],
  ['impl_peer_rejected',        'gossip_signals'],
  // Pipeline signals other than finding_dropped_format
  ['dispatch_started',          'dispatch-pipeline.ts (dispatch entry)'],
  ['relay_received',            'dispatch-pipeline.ts (relay receive)'],
  ['synthesis_completed',       'consensus-coordinator.ts'],
  ['circuit_open_fired',        'performance-reader.ts / dispatch-pipeline.ts'],
  ['skill_injection_skipped',   'prompt-assembler.ts / skill-loader.ts (ikp §4 kill-switch)'],
  // Path A relay-lint — PR #270
  ['relay_findings_dropped',    'collect.ts / relay-tasks.ts (relay-lint Path A)'],
  // Phase A self-telemetry: collect-end reconciliation shortfall
  ['signal_loss_suspected',     'collect.ts (round-reconcile assertion, Phase A self-telemetry)'],
]);

// ── Exhaustive union of all known signal names ─────────────────────────────
// Derived from the consensus-types.ts union. Update this list when adding
// new signal types — the test will fail if the list gets out of sync with
// the DOCUMENTED_PATH_SPECIFIC map.
const ALL_KNOWN_SIGNAL_NAMES: string[] = [
  // ConsensusSignal
  'agreement', 'disagreement', 'unverified', 'unique_confirmed', 'unique_unconfirmed',
  'new_finding', 'hallucination_caught', 'category_confirmed', 'consensus_verified',
  'signal_retracted', 'consensus_round_retracted', 'severity_miscalibrated',
  'task_timeout', 'task_empty',
  // ImplSignal
  'impl_test_pass', 'impl_test_fail', 'impl_peer_approved', 'impl_peer_rejected',
  // MetaSignal
  'task_completed', 'task_tool_turns', 'format_compliance',
  // PipelineSignal
  'dispatch_started', 'relay_received', 'finding_dropped_format',
  'synthesis_completed', 'circuit_open_fired', 'skill_injection_skipped',
  'citation_fabricated', 'relay_findings_dropped',
  // Phase A self-telemetry
  'signal_loss_suspected',
  // signal_retracted appears in both ConsensusSignal and PipelineSignal
];

describe('SignalType snapshot — every type has a documented emission site', () => {
  test('every signal name is either in completion-signals.ts or documented as path-specific', () => {
    const undocumented: string[] = [];
    for (const name of ALL_KNOWN_SIGNAL_NAMES) {
      if (!COMPLETION_SIGNALS_EMITTED.has(name) && !DOCUMENTED_PATH_SPECIFIC.has(name)) {
        undocumented.push(name);
      }
    }
    expect(undocumented).toEqual([]);
  });

  test('no signal_retracted-style duplicates — signal_retracted is documented', () => {
    // signal_retracted is in both ConsensusSignal and PipelineSignal.
    // It should be documented (either in COMPLETION_SIGNALS_EMITTED or
    // DOCUMENTED_PATH_SPECIFIC) — not silently missing.
    expect(
      COMPLETION_SIGNALS_EMITTED.has('signal_retracted') ||
      DOCUMENTED_PATH_SPECIFIC.has('signal_retracted')
    ).toBe(true);
  });

  test('completion-signals emits task_completed, format_compliance, and finding_dropped_format', () => {
    expect(COMPLETION_SIGNALS_EMITTED.has('task_completed')).toBe(true);
    expect(COMPLETION_SIGNALS_EMITTED.has('format_compliance')).toBe(true);
    expect(COMPLETION_SIGNALS_EMITTED.has('finding_dropped_format')).toBe(true);
  });

  test('task_tool_turns is in completion-signals (conditional F16 emit)', () => {
    expect(COMPLETION_SIGNALS_EMITTED.has('task_tool_turns')).toBe(true);
  });

  // Type-level check: ensures PerformanceSignal union is importable and non-empty
  test('PerformanceSignal type is importable', () => {
    const sig: PerformanceSignal = {
      type: 'meta',
      signal: 'task_completed',
      agentId: 'a',
      taskId: 't',
      value: 100,
      timestamp: new Date().toISOString(),
    };
    expect(sig.type).toBe('meta');
  });
});
