// tests/orchestrator/operational-class-row-exclusion.test.ts
//
// Pins the row-level `signal_class: 'operational'` exclusion on the two
// orchestrator-side accuracy surfaces consolidated by PR #692:
//
//   a. PerformanceReader.getCountersSince  — performance-reader.ts raw fallback
//   b. rebuildAggregateIndex               — signal-aggregate-index.ts rebuild loop
//
// (The third surface, packages/relay's dashboard `buildSignalIndex`, is pinned
// by tests/relay/api-skills-operational-class-exclusion.test.ts.)
//
// WHY THIS FILE EXISTS: consensus f0a881eb-756e4580:f11 found that deleting any
// of the three `isOperationalClassRow(...)` guards left the whole suite green.
// The pre-existing signal-aggregate-index tests only feed operational SIGNAL
// NAMES (task_timeout / transport_failure / boundary_escape), which
// `classifyForAggregate` already maps to 'none' — so they short-circuit on the
// NEXT line and cannot distinguish the guard's presence.
//
// The discriminating fixture is therefore a row that is operational by CLASS but
// looks like a scoring verdict by every other axis: a scoring signal NAME
// ('agreement' / 'hallucination_caught'), a truthy `category`, a live timestamp,
// and no retraction. Only the class stamp keeps it out.
//
// HOW WE KNOW EACH TEST FAILS IF ITS GUARD LINE IS DELETED (no source mutation
// was performed — this is the mutation-equivalence argument):
//
//   1. The operational fixture row and its positive control differ in exactly
//      one field that any filter READS as a discriminator: `signal_class`.
//      (They also differ in `agentId` and the derived `taskId`, which is what
//      separates the two populations — but each surface is queried per-agent
//      and the control proves the counted path works for its own agent, so
//      neither field can substitute for the guard.) Every other axis the
//      filters read (type, signal, category, timestamp, retraction keys) is
//      identical.
//   2. `signal_class` is read in three places in the orchestrator:
//      `isOperationalClassRow` (performance-reader.ts:247),
//      `isOperationalDisagreement` (:280), and `stampSignalClass`
//      (performance-writer.ts:138). The third is unreachable here: it runs only
//      inside PerformanceWriter's append methods, and these fixtures write the
//      ledger directly with `fs.writeFileSync`, bypassing the writer entirely.
//      Neither signal-aggregate-index.ts nor the reader's `readSignalsRaw`
//      inspects the field on its own;
//      `isOperationalDisagreement` is reached only from `computeScores`, which
//      neither surface under test calls.
//   3. So on both paths the ONLY code that can distinguish the two rows is the
//      guard line under test.
//   4. The control assertions below prove the control row IS counted / folded.
//      Deleting the guard therefore makes the operational row take the control's
//      path and produce the control's numbers, breaking the exclusion assertion.
//
// The control is thus the empirical half of the proof: if a fixture silently
// stopped reaching the guard, the control would stop being counted too and fail
// loudly instead of letting the exclusion test pass vacuously.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PerformanceReader, rebuildAggregateIndex } from '@gossip/orchestrator';

const CATEGORY = 'testing';
const OPERATIONAL_AGENT = 'ops-agent';
const CONTROL_AGENT = 'control-agent';

/** Fixed clock so `sinceMs` windows and bucket keys are deterministic. */
const NOW_MS = Date.UTC(2026, 6, 20, 12, 0, 0);
const SINCE_MS = NOW_MS - 60 * 60 * 1000;

interface RowOverrides {
  agentId: string;
  signal: 'agreement' | 'hallucination_caught';
  signal_class?: 'operational' | 'performance';
}

function row(o: RowOverrides): Record<string, unknown> {
  return {
    type: 'consensus',
    signal: o.signal,
    signal_class: o.signal_class,
    agentId: o.agentId,
    taskId: `task-${o.agentId}-${o.signal}`,
    category: CATEGORY,
    severity: 'medium',
    evidence: 'fixture row',
    timestamp: new Date(NOW_MS).toISOString(),
  };
}

/**
 * Writes agent-performance.jsonl ONLY — deliberately no aggregate sidecar. See
 * the note on the getCountersSince test for why that matters.
 */
function seedProjectRoot(prefix: string, rows: Array<Record<string, unknown>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.gossip'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.gossip', 'agent-performance.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n',
  );
  return root;
}

const FIXTURE_ROWS = [
  // Operational by class, scoring by every other axis.
  row({ agentId: OPERATIONAL_AGENT, signal: 'agreement', signal_class: 'operational' }),
  row({ agentId: OPERATIONAL_AGENT, signal: 'hallucination_caught', signal_class: 'operational' }),
  // Positive control — identical shape, scoring class.
  row({ agentId: CONTROL_AGENT, signal: 'agreement', signal_class: 'performance' }),
  row({ agentId: CONTROL_AGENT, signal: 'hallucination_caught', signal_class: 'performance' }),
];

describe('operational-class row exclusion (consensus f0a881eb-756e4580:f11)', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  function makeRoot(prefix: string): string {
    const root = seedProjectRoot(prefix, FIXTURE_ROWS);
    roots.push(root);
    return root;
  }

  describe('(a) PerformanceReader.getCountersSince', () => {
    // Sidecar fast path: `getCountersSince` consults `readAggregateIndex` first
    // and only falls through to the per-row raw scan when there is no usable
    // sidecar. This fixture writes NO `.gossip/signal-aggregate-index.json`, so
    // `readAggregateIndex` returns null and the raw fallback — the branch that
    // holds the `isOperationalClassRow` guard — is the one under test.
    //
    // Deliberate choice: the guard lives ONLY on the raw fallback. Asserting
    // through the sidecar would exercise `rebuildAggregateIndex`'s guard
    // instead (covered separately below) and would pass even if the raw
    // fallback's guard were deleted.

    it('does not count operational-class rows even when they carry a category', () => {
      const reader = new PerformanceReader(makeRoot('gossip-counters-op-'));
      expect(reader.getCountersSince(OPERATIONAL_AGENT, CATEGORY, SINCE_MS)).toEqual({
        correct: 0,
        hallucinated: 0,
      });
    });

    it('positive control — the same rows stamped performance ARE counted', () => {
      const reader = new PerformanceReader(makeRoot('gossip-counters-ctl-'));
      expect(reader.getCountersSince(CONTROL_AGENT, CATEGORY, SINCE_MS)).toEqual({
        correct: 1,
        hallucinated: 1,
      });
    });
  });

  describe('(b) rebuildAggregateIndex', () => {
    it('folds no bucket for an agent whose only rows are operational-class', () => {
      const data = rebuildAggregateIndex(makeRoot('gossip-rebuild-op-'));
      const buckets = data.agents[OPERATIONAL_AGENT];
      // Either the agent is absent entirely or it has no bucket for the category.
      expect(buckets?.[CATEGORY]).toBeUndefined();
    });

    it('positive control — performance-class rows DO produce a bucket', () => {
      const data = rebuildAggregateIndex(makeRoot('gossip-rebuild-ctl-'));
      const categoryBuckets = data.agents[CONTROL_AGENT]?.[CATEGORY];
      expect(categoryBuckets).toBeDefined();
      const totals = Object.values(categoryBuckets ?? {}).reduce(
        (acc, b) => ({
          correct: acc.correct + b.correct,
          hallucinated: acc.hallucinated + b.hallucinated,
        }),
        { correct: 0, hallucinated: 0 },
      );
      expect(totals).toEqual({ correct: 1, hallucinated: 1 });
    });
  });
});
