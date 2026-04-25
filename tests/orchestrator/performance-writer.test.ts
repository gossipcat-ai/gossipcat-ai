// tests/orchestrator/performance-writer.test.ts
import { PerformanceWriter } from '@gossip/orchestrator';
import { ConsensusSignal } from '@gossip/orchestrator';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// L2: sanctioned internal accessor for tests (Step 5 exemption).
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

describe('PerformanceWriter', () => {
  let tmpDir: string;
  let writer: PerformanceWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-l2-'));
    fs.mkdirSync(path.join(tmpDir, '.gossip'), { recursive: true });
    writer = new PerformanceWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends a signal to agent-performance.jsonl', () => {
    const signal: ConsensusSignal = {
      type: 'consensus',
      taskId: 'abc123',
      signal: 'agreement',
      agentId: 'gemini-reviewer',
      counterpartId: 'gemini-tester',
      evidence: 'both found SQL injection at auth.ts:47',
      timestamp: '2026-03-24T10:00:00Z',
    };
    writer[WRITER_INTERNAL].appendSignal(signal);

    const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    // _emission_path is stamped out-of-band on every row (L3 drift guard);
    // compare by toMatchObject so existing shape assertions still pass.
    expect(JSON.parse(lines[0])).toMatchObject(signal);
    expect(JSON.parse(lines[0])._emission_path).toBe('unknown');
  });

  it('appends multiple signals', () => {
    const signal1: ConsensusSignal = {
      type: 'consensus', taskId: 't1', signal: 'agreement',
      agentId: 'a', evidence: 'e1', timestamp: '2026-03-24T10:00:00Z',
    };
    const signal2: ConsensusSignal = {
      type: 'consensus', taskId: 't2', signal: 'disagreement',
      agentId: 'b', counterpartId: 'a', outcome: 'correct',
      evidence: 'e2', timestamp: '2026-03-24T10:01:00Z',
    };
    writer[WRITER_INTERNAL].appendSignal(signal1);
    writer[WRITER_INTERNAL].appendSignal(signal2);

    const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('appendSignals batch writes', () => {
    const signals: ConsensusSignal[] = [
      { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'a', evidence: 'e1', timestamp: '2026-03-24T10:00:00Z' },
      { type: 'consensus', taskId: 't2', signal: 'new_finding', agentId: 'b', evidence: 'e2', timestamp: '2026-03-24T10:01:00Z' },
    ];
    writer[WRITER_INTERNAL].appendSignals(signals);

    const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  describe('validateSignal — rejects invalid signals', () => {
    it('rejects signal with empty taskId', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'consensus', taskId: '', signal: 'agreement',
        agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('taskId');
    });

    it('rejects signal with missing agentId', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'consensus', taskId: 't1', signal: 'agreement',
        agentId: '', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('agentId');
    });

    it('rejects signal with invalid timestamp', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'consensus', taskId: 't1', signal: 'agreement',
        agentId: 'a', evidence: 'e', timestamp: 'not-a-date',
      })).toThrow('timestamp');
    });

    it('rejects signal with unknown consensus signal type', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'consensus', taskId: 't1', signal: 'made_up' as any,
        agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('signal');
    });

    it('rejects signal with unknown type field', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'unknown' as any, taskId: 't1', signal: 'agreement',
        agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('type');
    });

    it('accepts valid consensus signal', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'consensus', taskId: 't1', signal: 'agreement',
        agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).not.toThrow();
    });

    it('accepts valid impl signal', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'impl', signal: 'impl_test_pass',
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).not.toThrow();
    });

    it('accepts valid meta signal', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'meta', signal: 'task_completed',
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).not.toThrow();
    });

    // PR #270 review (CRITICAL): relay_findings_dropped MUST be in the
    // VALID_PIPELINE_SIGNALS allowlist. Pre-fix, validateSignal threw on it
    // and the catch in handleNativeRelay silently swallowed every emission,
    // so the relay-warnings.jsonl file existed but no signal pipeline saw it.
    it('accepts relay_findings_dropped as a valid pipeline signal', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'pipeline',
        signal: 'relay_findings_dropped',
        agentId: 'sonnet-reviewer',
        taskId: 't-relay-1',
        timestamp: '2026-04-25T10:00:00Z',
        metadata: {
          reason: 'no_tagged_findings_in_result',
          resultLength: 248,
          suspectedReason: 'orchestrator_paraphrase',
        },
      } as any)).not.toThrow();
    });

    it('rejects unknown pipeline signal enum', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'pipeline', signal: 'fake_pipeline' as any,
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('signal');
    });

    it('rejects unknown impl signal enum', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'impl', signal: 'fake_impl' as any,
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('signal');
    });

    it('rejects unknown meta signal enum', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'meta', signal: 'fake_meta' as any,
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('signal');
    });

    it('appendSignals rejects batch with any invalid signal', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignals([
        { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z' },
        { type: 'consensus', taskId: '', signal: 'agreement', agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z' },
      ])).toThrow('taskId');
    });
  });

  // ── L2 regression guards (Step 1a + Step 1) ────────────────────────────────

  describe('L2 — Step 1a: severity_miscalibrated allowlist fix', () => {
    // Pre-fix: validateSignal threw on 'severity_miscalibrated'; every emission
    // was silently swallowed. (spec §4, consensus 78bc92ef-23464bde:f11)
    it('accepts severity_miscalibrated as a valid consensus signal', () => {
      expect(() => writer[WRITER_INTERNAL].appendSignal({
        type: 'consensus',
        signal: 'severity_miscalibrated',
        agentId: 'test-agent',
        taskId: 'task-001',
        timestamp: new Date().toISOString(),
        evidence: 'test: miscalibrated severity on finding X',
      })).not.toThrow();
    });

    it('severity_miscalibrated round-trips to jsonl', () => {
      writer[WRITER_INTERNAL].appendSignal({
        type: 'consensus',
        signal: 'severity_miscalibrated',
        agentId: 'test-agent',
        taskId: 'task-001',
        timestamp: new Date().toISOString(),
        evidence: 'test: miscalibrated severity on finding X',
      });
      const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.signal).toBe('severity_miscalibrated');
      expect(last.type).toBe('consensus');
    });
  });

  describe('L2 — Step 1: Symbol-accessor boundary', () => {
    // The Symbol-keyed instance field makes appendSignal / appendSignals invisible
    // as plain properties. TS rejects `writer.appendSignals(...)` at compile time.
    // These tests verify the runtime boundary is also in effect.
    it('does not expose appendSignals as a plain enumerable property', () => {
      const w = new PerformanceWriter(tmpDir);
      expect((w as any).appendSignals).toBeUndefined();
    });

    it('does not expose appendSignal as a plain enumerable property', () => {
      const w = new PerformanceWriter(tmpDir);
      expect((w as any).appendSignal).toBeUndefined();
    });
  });
});
