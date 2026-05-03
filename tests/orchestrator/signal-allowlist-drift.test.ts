// @gossip:impact-adjacent:signal_pipeline
//
// Drift detector: catches the PR #329 class of bug.
//
// gossipcat has THREE parallel taxonomies of signal names:
//   1. TypeScript union types in `ConsensusSignal['signal']` etc — compile-time
//   2. Runtime `VALID_*_SIGNALS` Sets in performance-writer.ts — checked by validateSignal
//   3. `PERFORMANCE_SIGNAL_NAMES` + `OPERATIONAL_SIGNAL_NAMES` in consensus-types.ts —
//      used by classifySignal to stamp signal_class on every row
//
// Drift between any two silently breaks the pipeline. PR #329 fixed drift between #1+#2:
// `transport_failure` was added to the ConsensusSignal union but missing from
// VALID_CONSENSUS_SIGNALS, so every transport_failure emit was silently dropped by
// validateSignal — masking the fail-closed signal that PR #328 had just shipped.
//
// This test asserts bidirectional consistency between the runtime sets so future drift
// fails the build instead of failing silently.

import {
  classifySignal,
  PERFORMANCE_SIGNAL_NAMES,
  OPERATIONAL_SIGNAL_NAMES,
} from '../../packages/orchestrator/src/consensus-types';
import {
  VALID_CONSENSUS_SIGNALS,
  VALID_IMPL_SIGNALS,
  VALID_META_SIGNALS,
  VALID_PIPELINE_SIGNALS,
} from '../../packages/orchestrator/src/performance-writer';

// Names that are allowed to live in only ONE of the two taxonomies.
//
// VALID_*_SIGNALS members can be system/observability-only and intentionally not
// classifiable (no signal_class needed): they show up on the dashboard's "ops"
// counters, not in scoring math. classifySignal() returning undefined for these
// is correct.
const CLASSIFY_OPT_OUT = new Set<string>([
  // Pipeline self-telemetry — system-scoped, not per-agent
  'dispatch_started',
  'relay_received',
  'synthesis_completed',
  'circuit_open_fired',
  'skill_injection_skipped',
  'finding_dropped_format',
  'relay_findings_dropped',
  'signal_loss_suspected',

  // Consensus-level meta — recorded for observability, not classified
  'severity_miscalibrated',
  'boundary_escape',
  'consensus_coverage_degraded',
  'consensus_round_retracted',
  'unverified',
  'citation_fabricated',

  // Cross-class control signal (appears in both VALID_CONSENSUS and VALID_PIPELINE)
  'signal_retracted',
]);

describe('signal allowlist drift detector', () => {
  describe('VALID_*_SIGNALS classification coverage', () => {
    it('every consensus signal classifies (or is on the opt-out list)', () => {
      const unclassified: string[] = [];
      for (const name of VALID_CONSENSUS_SIGNALS) {
        if (CLASSIFY_OPT_OUT.has(name)) continue;
        if (classifySignal(name) === undefined) unclassified.push(name);
      }
      expect(unclassified).toEqual([]);
    });

    it('every impl signal classifies (or is on the opt-out list)', () => {
      const unclassified: string[] = [];
      for (const name of VALID_IMPL_SIGNALS) {
        if (CLASSIFY_OPT_OUT.has(name)) continue;
        if (classifySignal(name) === undefined) unclassified.push(name);
      }
      expect(unclassified).toEqual([]);
    });

    it('every meta signal classifies (or is on the opt-out list)', () => {
      const unclassified: string[] = [];
      for (const name of VALID_META_SIGNALS) {
        if (CLASSIFY_OPT_OUT.has(name)) continue;
        if (classifySignal(name) === undefined) unclassified.push(name);
      }
      expect(unclassified).toEqual([]);
    });
  });

  describe('PERFORMANCE / OPERATIONAL NAMES coverage', () => {
    it('every PERFORMANCE_SIGNAL_NAMES member is in some VALID_*_SIGNALS set', () => {
      const allValid = new Set([
        ...VALID_CONSENSUS_SIGNALS,
        ...VALID_IMPL_SIGNALS,
        ...VALID_META_SIGNALS,
        ...VALID_PIPELINE_SIGNALS,
      ]);
      const orphans: string[] = [];
      for (const name of PERFORMANCE_SIGNAL_NAMES) {
        if (!allValid.has(name)) orphans.push(name);
      }
      // Orphans here are signals that classifySignal would stamp signal_class on
      // but validateSignal would reject — every emit silently dropped.
      // This is the PR #329 case in reverse direction.
      expect(orphans).toEqual([]);
    });

    it('every OPERATIONAL_SIGNAL_NAMES member is in some VALID_*_SIGNALS set', () => {
      const allValid = new Set([
        ...VALID_CONSENSUS_SIGNALS,
        ...VALID_IMPL_SIGNALS,
        ...VALID_META_SIGNALS,
        ...VALID_PIPELINE_SIGNALS,
      ]);
      const orphans: string[] = [];
      for (const name of OPERATIONAL_SIGNAL_NAMES) {
        if (!allValid.has(name)) orphans.push(name);
      }
      // Same failure mode as above: classified but rejected at validateSignal.
      // This is the exact PR #329 bug — `transport_failure` was in
      // OPERATIONAL_SIGNAL_NAMES but missing from VALID_CONSENSUS_SIGNALS.
      expect(orphans).toEqual([]);
    });
  });

  describe('classifySignal returns the correct class', () => {
    it('every PERFORMANCE_SIGNAL_NAMES member classifies as performance', () => {
      for (const name of PERFORMANCE_SIGNAL_NAMES) {
        expect(classifySignal(name)).toBe('performance');
      }
    });

    it('every OPERATIONAL_SIGNAL_NAMES member classifies as operational', () => {
      for (const name of OPERATIONAL_SIGNAL_NAMES) {
        expect(classifySignal(name)).toBe('operational');
      }
    });
  });

  describe('opt-out hygiene', () => {
    it('every CLASSIFY_OPT_OUT member is in some VALID_*_SIGNALS set (no orphan opt-outs)', () => {
      const allValid = new Set([
        ...VALID_CONSENSUS_SIGNALS,
        ...VALID_IMPL_SIGNALS,
        ...VALID_META_SIGNALS,
        ...VALID_PIPELINE_SIGNALS,
      ]);
      const orphans: string[] = [];
      for (const name of CLASSIFY_OPT_OUT) {
        if (!allValid.has(name)) orphans.push(name);
      }
      // Catches the case where a signal is removed from VALID_*_SIGNALS but the
      // opt-out list still references it — the opt-out list is now lying.
      expect(orphans).toEqual([]);
    });
  });
});
