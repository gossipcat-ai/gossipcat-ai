// tests/orchestrator/signal-class.test.ts
//
// PR 5 / Option 5B (2026-04-21) — `signal_class` discriminator on
// PerformanceSignal rows. Verifies:
//   a. explicit signal_class round-trips through write/read intact,
//   b. missing signal_class is accepted (no crash) and gets auto-stamped
//      when the classifier recognises the signal name,
//   c. operational signal + undefined category behaves as today (no regression),
//   d. downstream filtering by signal_class partitions rows as spec says.
//
// Write-forward only: no historical backfill, the reader path is unchanged
// by this PR, so we exercise the writer + parse-from-disk contract directly.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PerformanceWriter, classifySignal } from '@gossip/orchestrator';
import type {
  ConsensusSignal,
  ImplSignal,
  MetaSignal,
  PipelineSignal,
  PerformanceSignal,
  SignalClass,
} from '@gossip/orchestrator';
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

function readRows(tmpDir: string): Array<Record<string, unknown>> {
  const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

describe('signal_class discriminator (PR 5)', () => {
  let tmpDir: string;
  let writer: PerformanceWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-signal-class-'));
    fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
    writer = new PerformanceWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('classifySignal', () => {
    it('maps performance signal names', () => {
      expect(classifySignal('agreement')).toBe('performance');
      expect(classifySignal('disagreement')).toBe('performance');
      expect(classifySignal('unique_confirmed')).toBe('performance');
      expect(classifySignal('unique_unconfirmed')).toBe('performance');
      expect(classifySignal('new_finding')).toBe('performance');
      expect(classifySignal('hallucination_caught')).toBe('performance');
      expect(classifySignal('impl_test_pass')).toBe('performance');
      expect(classifySignal('impl_test_fail')).toBe('performance');
      expect(classifySignal('impl_peer_approved')).toBe('performance');
      expect(classifySignal('impl_peer_rejected')).toBe('performance');
    });

    it('maps operational signal names', () => {
      expect(classifySignal('task_completed')).toBe('operational');
      expect(classifySignal('task_tool_turns')).toBe('operational');
      expect(classifySignal('format_compliance')).toBe('operational');
      expect(classifySignal('signal_retracted')).toBe('operational');
      expect(classifySignal('task_timeout')).toBe('operational');
      expect(classifySignal('task_empty')).toBe('operational');
      expect(classifySignal('citation_fabricated')).toBe('operational');
      expect(classifySignal('finding_dropped_format')).toBe('operational');
      expect(classifySignal('consensus_round_retracted')).toBe('operational');
      expect(classifySignal('unverified')).toBe('operational');
    });

    it('classifies category_confirmed / consensus_verified as performance', () => {
      // These are evidence-of-correctness signals — they affect agent accuracy
      // and belong in the performance bucket alongside agreement / hallucination_caught.
      expect(classifySignal('category_confirmed')).toBe('performance');
      expect(classifySignal('consensus_verified')).toBe('performance');
    });

    it('returns undefined for unclassified (spec-silent) signal names', () => {
      // Intentional: conservative rollout. Leaving ambiguous names undefined
      // avoids committing to a class before a downstream consumer needs it.
      expect(classifySignal('severity_miscalibrated')).toBeUndefined();
      expect(classifySignal('boundary_escape')).toBeUndefined();
      expect(classifySignal('dispatch_started')).toBeUndefined();
      expect(classifySignal('relay_received')).toBeUndefined();
      expect(classifySignal('synthesis_completed')).toBeUndefined();
      expect(classifySignal('skill_injection_skipped')).toBeUndefined();
    });
  });

  describe('(a) signal_class round-trips intact when set explicitly', () => {
    it('preserves caller-provided performance class on a ConsensusSignal', () => {
      const signal: ConsensusSignal = {
        type: 'consensus',
        signal_class: 'performance',
        taskId: 't1',
        signal: 'agreement',
        agentId: 'a',
        counterpartId: 'b',
        evidence: 'e1',
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal);

      const [row] = readRows(tmpDir);
      expect(row.signal_class).toBe('performance');
    });

    it('preserves caller-provided operational class even when the signal name is a performance name', () => {
      // Stamper must NOT overwrite an explicit value — even a "wrong" one.
      // This protects forward-compat: if a future caller sets signal_class
      // deliberately, we honour it verbatim.
      const signal: ConsensusSignal = {
        type: 'consensus',
        signal_class: 'operational',
        taskId: 't1',
        signal: 'agreement', // classifier would auto-stamp 'performance'
        agentId: 'a',
        evidence: 'e1',
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal);

      const [row] = readRows(tmpDir);
      expect(row.signal_class).toBe('operational');
    });
  });

  describe('(b) missing signal_class is accepted (no crash) and auto-stamped', () => {
    it('auto-stamps performance on unset ConsensusSignal.agreement', () => {
      const signal: ConsensusSignal = {
        type: 'consensus',
        taskId: 't1',
        signal: 'agreement',
        agentId: 'a',
        counterpartId: 'b',
        evidence: 'e',
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal);
      expect(readRows(tmpDir)[0].signal_class).toBe('performance');
    });

    it('auto-stamps operational on unset MetaSignal.task_completed', () => {
      const signal: MetaSignal = {
        type: 'meta',
        signal: 'task_completed',
        agentId: 'a',
        taskId: 't1',
        value: 1234,
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal);
      expect(readRows(tmpDir)[0].signal_class).toBe('operational');
    });

    it('auto-stamps performance on unset ImplSignal.impl_test_pass', () => {
      const signal: ImplSignal = {
        type: 'impl',
        signal: 'impl_test_pass',
        agentId: 'a',
        taskId: 't1',
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal);
      expect(readRows(tmpDir)[0].signal_class).toBe('performance');
    });

    it('auto-stamps operational on unset PipelineSignal.finding_dropped_format', () => {
      const signal: PipelineSignal = {
        type: 'pipeline',
        signal: 'finding_dropped_format',
        agentId: 'a',
        taskId: 't1',
        value: 2,
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal);
      expect(readRows(tmpDir)[0].signal_class).toBe('operational');
    });

    it('auto-stamps operational on unset PipelineSignal.citation_fabricated', () => {
      const signal: PipelineSignal = {
        type: 'pipeline',
        signal: 'citation_fabricated',
        agentId: 'a',
        taskId: 't1',
        value: 3,
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal);
      expect(readRows(tmpDir)[0].signal_class).toBe('operational');
    });
  });

  describe('(c) signal_class undefined + category undefined → no regression', () => {
    it('leaves signal_class absent when the classifier cannot decide', () => {
      // `boundary_escape` is intentionally unclassified (observability-only).
      // Write-forward safety: the row still lands, existing reader code still
      // aggregates it exactly as before, signal_class just isn't populated.
      const signal: ConsensusSignal = {
        type: 'consensus',
        taskId: 't1',
        signal: 'boundary_escape',
        agentId: 'a',
        evidence: 'e',
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal);

      const [row] = readRows(tmpDir);
      expect(row.signal).toBe('boundary_escape');
      expect(row.signal_class).toBeUndefined();
      // Existing fields round-trip untouched — no regression in pre-existing shape.
      expect(row.type).toBe('consensus');
      expect(row.agentId).toBe('a');
      expect((row as { category?: unknown }).category).toBeUndefined();
    });
  });

  describe('(d) downstream filtering by signal_class', () => {
    it('partitions a mixed batch into performance / operational buckets', () => {
      const now = '2026-04-21T10:00:00Z';
      const batch: PerformanceSignal[] = [
        // performance
        { type: 'consensus', taskId: 't', signal: 'agreement', agentId: 'a', counterpartId: 'b', evidence: 'e', timestamp: now },
        { type: 'consensus', taskId: 't', signal: 'hallucination_caught', agentId: 'a', evidence: 'e', timestamp: now },
        { type: 'impl', signal: 'impl_peer_rejected', agentId: 'a', taskId: 't', timestamp: now },
        // operational
        { type: 'meta', signal: 'task_completed', agentId: 'a', taskId: 't', value: 10, timestamp: now },
        { type: 'meta', signal: 'format_compliance', agentId: 'a', taskId: 't', value: 1, timestamp: now },
        { type: 'pipeline', signal: 'finding_dropped_format', agentId: 'a', taskId: 't', value: 1, timestamp: now },
        { type: 'consensus', taskId: 't', signal: 'unverified', agentId: 'a', evidence: 'e', timestamp: now },
        // unclassified — should not land in either bucket
        { type: 'consensus', taskId: 't', signal: 'boundary_escape', agentId: 'a', evidence: 'e', timestamp: now },
      ];

      writer[WRITER_INTERNAL].appendSignals(batch);

      const rows = readRows(tmpDir);
      const performance = rows.filter(r => r.signal_class === 'performance');
      const operational = rows.filter(r => r.signal_class === 'operational');
      const unclassified = rows.filter(r => r.signal_class === undefined);

      expect(performance.map(r => r.signal)).toEqual(
        ['agreement', 'hallucination_caught', 'impl_peer_rejected'],
      );
      expect(operational.map(r => r.signal)).toEqual(
        ['task_completed', 'format_compliance', 'finding_dropped_format', 'unverified'],
      );
      expect(unclassified.map(r => r.signal)).toEqual(['boundary_escape']);
    });

    it('preserves _emission_path on stamped rows (no collision with L3 drift guard)', () => {
      const signal: MetaSignal = {
        type: 'meta',
        signal: 'task_completed',
        agentId: 'a',
        taskId: 't',
        value: 1,
        timestamp: '2026-04-21T10:00:00Z',
      };
      writer[WRITER_INTERNAL].appendSignal(signal, 'completion-signals-helper');

      const [row] = readRows(tmpDir);
      expect(row.signal_class).toBe('operational');
      expect(row._emission_path).toBe('completion-signals-helper');
    });
  });

  // Type-level smoke check: SignalClass is a named, reusable alias.
  it('exports SignalClass as a reusable type alias', () => {
    const cls: SignalClass = 'performance';
    expect(cls).toBe('performance');
  });

  // Consensus 466933ec-548b45cf f12: the failed-task bridge in collect.ts
  // explicitly stamps signal_class:'operational' on disagreement rows emitted
  // for failed tasks. This hardens the reader guard via a second axis.
  it('preserves explicit signal_class:operational on a disagreement signal (failed-task bridge)', () => {
    const signal: ConsensusSignal = {
      type: 'consensus',
      signal_class: 'operational',
      taskId: 't-failed',
      signal: 'disagreement',
      agentId: 'gemini-reviewer',
      evidence: 'Task failed: provider error',
      timestamp: '2026-04-22T10:00:00Z',
    };
    writer[WRITER_INTERNAL].appendSignal(signal);

    const [row] = readRows(tmpDir);
    expect(row.signal).toBe('disagreement');
    expect(row.signal_class).toBe('operational');
  });
});
