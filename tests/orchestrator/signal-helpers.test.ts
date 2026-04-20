// tests/orchestrator/signal-helpers.test.ts
//
// PR C Stream B — coverage for the L2 typed signal helpers
// (packages/orchestrator/src/signal-helpers.ts). Addresses carried finding
// gemini-tester f1 MED (consensus fb3ea8fc-6e674462): the helper matrix
// previously lacked explicit cases for 'unverified' and
// 'consensus_round_retracted'. Both are exercised by name below.
//
// Companion to tests/orchestrator/completion-signals-parity.test.ts (Stream A)
// and tests/orchestrator/performance-writer.test.ts (Step 1/1a writer guards).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  emitConsensusSignals,
  emitSandboxSignals,
  emitImplSignals,
  emitScoringAdjustmentSignals,
  emitPipelineSignals,
} from '@gossip/orchestrator';
import type {
  ConsensusSignal,
  ImplSignal,
  PipelineSignal,
  PerformanceSignal,
} from '../../packages/orchestrator/src/consensus-types';

// Mirror of VALID_CONSENSUS_SIGNALS in performance-writer.ts L30-39.
// Kept inline so the test fails loudly if the writer allowlist shrinks.
const CONSENSUS_SIGNAL_VARIANTS: ConsensusSignal['signal'][] = [
  'agreement',
  'disagreement',
  'unverified',
  'unique_confirmed',
  'unique_unconfirmed',
  'new_finding',
  'hallucination_caught',
  'category_confirmed',
  'consensus_verified',
  'signal_retracted',
  'consensus_round_retracted',
  'task_timeout',
  'task_empty',
  'severity_miscalibrated',
];

const JSONL = '.gossip/agent-performance.jsonl';

function readRows(tmpDir: string): any[] {
  const p = path.join(tmpDir, JSONL);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function baseConsensus(
  signal: ConsensusSignal['signal'],
  overrides: Partial<ConsensusSignal> = {},
): ConsensusSignal {
  return {
    type: 'consensus',
    signal,
    agentId: 'sonnet-reviewer',
    taskId: 'task-consensus-1',
    evidence: `test: ${signal}`,
    timestamp: '2026-04-20T10:00:00Z',
    ...overrides,
  };
}

describe('signal-helpers — typed emission surface (L2)', () => {
  let tmpDir: string;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-test-'));
    // Silence expected "[gossipcat] ... failed" lines from negative cases so
    // jest output stays readable. Captured for assertions where relevant.
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Full VALID_CONSENSUS_SIGNALS matrix ─────────────────────────────────
  describe('emitConsensusSignals — full VALID_CONSENSUS_SIGNALS matrix', () => {
    it.each(CONSENSUS_SIGNAL_VARIANTS)(
      "persists a '%s' consensus signal to agent-performance.jsonl",
      variant => {
        const signal = baseConsensus(variant, { taskId: `task-${variant}` });
        emitConsensusSignals(tmpDir, [signal]);

        const rows = readRows(tmpDir);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          type: 'consensus',
          signal: variant,
          agentId: 'sonnet-reviewer',
          taskId: `task-${variant}`,
        });
      },
    );

    it("explicitly covers the 'unverified' variant (carried finding gemini-tester f1)", () => {
      emitConsensusSignals(tmpDir, [baseConsensus('unverified')]);
      const rows = readRows(tmpDir);
      expect(rows[0].signal).toBe('unverified');
      expect(rows[0].type).toBe('consensus');
    });

    it("explicitly covers the 'consensus_round_retracted' variant (carried finding gemini-tester f1)", () => {
      emitConsensusSignals(tmpDir, [baseConsensus('consensus_round_retracted')]);
      const rows = readRows(tmpDir);
      expect(rows[0].signal).toBe('consensus_round_retracted');
      expect(rows[0].type).toBe('consensus');
    });
  });

  // ── 2. _emission_path stamping across all five helpers ────────────────────
  describe('_emission_path stamping', () => {
    it('emitConsensusSignals stamps _emission_path = signal-helpers-consensus', () => {
      emitConsensusSignals(tmpDir, [baseConsensus('agreement')]);
      expect(readRows(tmpDir)[0]._emission_path).toBe('signal-helpers-consensus');
    });

    it('emitSandboxSignals stamps _emission_path = signal-helpers-sandbox', () => {
      const sandbox: ConsensusSignal = baseConsensus('new_finding', {
        agentId: 'sandbox',
        taskId: 'boundary-escape-1',
        evidence: 'worktree_boundary_escape test',
      });
      emitSandboxSignals(tmpDir, sandbox);
      expect(readRows(tmpDir)[0]._emission_path).toBe('signal-helpers-sandbox');
    });

    it('emitImplSignals stamps _emission_path = signal-helpers-impl', () => {
      const impl: ImplSignal = {
        type: 'impl',
        signal: 'impl_test_pass',
        agentId: 'sonnet-implementer',
        taskId: 'impl-1',
        timestamp: '2026-04-20T10:00:00Z',
      };
      emitImplSignals(tmpDir, [impl]);
      expect(readRows(tmpDir)[0]._emission_path).toBe('signal-helpers-impl');
    });

    it('emitScoringAdjustmentSignals stamps _emission_path = signal-helpers-scoring', () => {
      const scoring: ConsensusSignal = baseConsensus('severity_miscalibrated', {
        claimedSeverity: 'critical',
        severity: 'medium',
      });
      emitScoringAdjustmentSignals(tmpDir, scoring);
      expect(readRows(tmpDir)[0]._emission_path).toBe('signal-helpers-scoring');
    });

    it('emitPipelineSignals stamps _emission_path = signal-helpers-pipeline', () => {
      const pipeline: PipelineSignal = {
        type: 'pipeline',
        signal: 'skill_injection_skipped',
        agentId: 'sonnet-reviewer',
        taskId: 'pipeline-1',
        timestamp: '2026-04-20T10:00:00Z',
      };
      emitPipelineSignals(tmpDir, [pipeline]);
      expect(readRows(tmpDir)[0]._emission_path).toBe('signal-helpers-pipeline');
    });
  });

  // ── 3. finding_id / findingId preservation ────────────────────────────────
  describe('findingId preservation', () => {
    it('emitConsensusSignals round-trips findingId exactly', () => {
      const findingId = 'abc-123:sonnet-reviewer:f1';
      emitConsensusSignals(tmpDir, [
        baseConsensus('unique_confirmed', { findingId }),
      ]);
      const rows = readRows(tmpDir);
      expect(rows).toHaveLength(1);
      expect(rows[0].findingId).toBe(findingId);
    });

    it('emitImplSignals preserves arbitrary extra fields on the envelope', () => {
      // ImplSignal has no findingId in the TS union, but writers should not
      // strip unknown fields that pass validateSignal's structural checks.
      const impl = {
        type: 'impl' as const,
        signal: 'impl_peer_approved' as const,
        agentId: 'sonnet-implementer',
        taskId: 'impl-42',
        timestamp: '2026-04-20T10:00:00Z',
        evidence: 'peer approved',
      };
      emitImplSignals(tmpDir, [impl]);
      const rows = readRows(tmpDir);
      expect(rows[0]).toMatchObject({
        type: 'impl',
        signal: 'impl_peer_approved',
        agentId: 'sonnet-implementer',
        taskId: 'impl-42',
      });
    });
  });

  // ── 4. Empty-batch short-circuit ──────────────────────────────────────────
  describe('empty batches are a no-op', () => {
    it('emitConsensusSignals([]) does not create the jsonl file', () => {
      emitConsensusSignals(tmpDir, []);
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
    });

    it('emitImplSignals([]) does not create the jsonl file', () => {
      emitImplSignals(tmpDir, []);
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
    });

    it('emitPipelineSignals([]) does not create the jsonl file', () => {
      emitPipelineSignals(tmpDir, []);
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
    });
  });

  // ── 5. Negative cases — swallowed errors, no throw to caller ──────────────
  describe('invalid input is swallowed and logged to stderr (never thrown)', () => {
    it('emitConsensusSignals rejects a batch whose items are not type=consensus', () => {
      const mixed: PerformanceSignal[] = [
        baseConsensus('agreement'),
        {
          type: 'impl',
          signal: 'impl_test_pass',
          agentId: 'a',
          taskId: 't',
          timestamp: '2026-04-20T10:00:00Z',
        },
      ];
      // Must not throw — helpers are try/catch wrapped end-to-end.
      expect(() => emitConsensusSignals(tmpDir, mixed)).not.toThrow();
      // And the file must NOT have been partially written — guard throws
      // before the writer runs.
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
      // Stderr gets a single diagnostic line.
      const calls = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(calls).toMatch(/emitConsensusSignals failed/);
      expect(calls).toMatch(/type='consensus'/);
    });

    it('emitImplSignals rejects a batch whose items are not type=impl', () => {
      const mixed: PerformanceSignal[] = [
        baseConsensus('agreement'),
      ];
      expect(() => emitImplSignals(tmpDir, mixed)).not.toThrow();
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
      const calls = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(calls).toMatch(/emitImplSignals failed/);
    });

    it('emitPipelineSignals rejects a batch whose items are not type=pipeline', () => {
      const mixed: PerformanceSignal[] = [baseConsensus('agreement')];
      expect(() => emitPipelineSignals(tmpDir, mixed)).not.toThrow();
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
      const calls = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(calls).toMatch(/emitPipelineSignals failed/);
    });

    it('emitConsensusSignals swallows writer-level validation errors (unknown signal name)', () => {
      const bogus = baseConsensus('agreement');
      (bogus as any).signal = 'made_up_signal';
      expect(() => emitConsensusSignals(tmpDir, [bogus])).not.toThrow();
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
      const calls = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(calls).toMatch(/emitConsensusSignals failed/);
    });

    it('emitSandboxSignals swallows writer-level validation errors', () => {
      const bad = baseConsensus('agreement', { agentId: '' });
      expect(() => emitSandboxSignals(tmpDir, bad)).not.toThrow();
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
      const calls = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(calls).toMatch(/emitSandboxSignals failed/);
    });

    it('emitScoringAdjustmentSignals swallows writer-level validation errors', () => {
      const bad = baseConsensus('severity_miscalibrated', { taskId: '' });
      expect(() => emitScoringAdjustmentSignals(tmpDir, bad)).not.toThrow();
      expect(fs.existsSync(path.join(tmpDir, JSONL))).toBe(false);
      const calls = stderrSpy.mock.calls.map(c => String(c[0])).join('');
      expect(calls).toMatch(/emitScoringAdjustmentSignals failed/);
    });
  });

  // ── 6. Batch write preserves ordering ─────────────────────────────────────
  describe('batch write ordering', () => {
    it('emitConsensusSignals persists all rows in call order', () => {
      const batch: ConsensusSignal[] = [
        baseConsensus('unverified', { taskId: 't-1' }),
        baseConsensus('unique_confirmed', { taskId: 't-2' }),
        baseConsensus('consensus_round_retracted', { taskId: 't-3' }),
      ];
      emitConsensusSignals(tmpDir, batch);
      const rows = readRows(tmpDir);
      expect(rows.map(r => r.taskId)).toEqual(['t-1', 't-2', 't-3']);
      expect(rows.map(r => r.signal)).toEqual([
        'unverified',
        'unique_confirmed',
        'consensus_round_retracted',
      ]);
      // Every row gets the same emission_path stamp.
      expect(new Set(rows.map(r => r._emission_path))).toEqual(
        new Set(['signal-helpers-consensus']),
      );
    });
  });
});
