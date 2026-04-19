// tests/orchestrator/performance-writer.test.ts
import { PerformanceWriter } from '@gossip/orchestrator';
import { ConsensusSignal } from '@gossip/orchestrator';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('PerformanceWriter', () => {
  let tmpDir: string;
  let writer: PerformanceWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-writer-'));
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
    writer.appendSignal(signal);

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
    writer.appendSignal(signal1);
    writer.appendSignal(signal2);

    const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('appendSignals batch writes', () => {
    const signals: ConsensusSignal[] = [
      { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'a', evidence: 'e1', timestamp: '2026-03-24T10:00:00Z' },
      { type: 'consensus', taskId: 't2', signal: 'new_finding', agentId: 'b', evidence: 'e2', timestamp: '2026-03-24T10:01:00Z' },
    ];
    writer.appendSignals(signals);

    const filePath = path.join(tmpDir, '.gossip', 'agent-performance.jsonl');
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  describe('validateSignal — rejects invalid signals', () => {
    it('rejects signal with empty taskId', () => {
      expect(() => writer.appendSignal({
        type: 'consensus', taskId: '', signal: 'agreement',
        agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('taskId');
    });

    it('rejects signal with missing agentId', () => {
      expect(() => writer.appendSignal({
        type: 'consensus', taskId: 't1', signal: 'agreement',
        agentId: '', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('agentId');
    });

    it('rejects signal with invalid timestamp', () => {
      expect(() => writer.appendSignal({
        type: 'consensus', taskId: 't1', signal: 'agreement',
        agentId: 'a', evidence: 'e', timestamp: 'not-a-date',
      })).toThrow('timestamp');
    });

    it('rejects signal with unknown consensus signal type', () => {
      expect(() => writer.appendSignal({
        type: 'consensus', taskId: 't1', signal: 'made_up' as any,
        agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('signal');
    });

    it('rejects signal with unknown type field', () => {
      expect(() => writer.appendSignal({
        type: 'unknown' as any, taskId: 't1', signal: 'agreement',
        agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('type');
    });

    it('accepts valid consensus signal', () => {
      expect(() => writer.appendSignal({
        type: 'consensus', taskId: 't1', signal: 'agreement',
        agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
      })).not.toThrow();
    });

    it('accepts valid impl signal', () => {
      expect(() => writer.appendSignal({
        type: 'impl', signal: 'impl_test_pass',
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).not.toThrow();
    });

    it('accepts valid meta signal', () => {
      expect(() => writer.appendSignal({
        type: 'meta', signal: 'task_completed',
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).not.toThrow();
    });

    it('rejects unknown impl signal enum', () => {
      expect(() => writer.appendSignal({
        type: 'impl', signal: 'fake_impl' as any,
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('signal');
    });

    it('rejects unknown meta signal enum', () => {
      expect(() => writer.appendSignal({
        type: 'meta', signal: 'fake_meta' as any,
        agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
      })).toThrow('signal');
    });

    it('appendSignals rejects batch with any invalid signal', () => {
      expect(() => writer.appendSignals([
        { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z' },
        { type: 'consensus', taskId: '', signal: 'agreement', agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z' },
      ])).toThrow('taskId');
    });
  });
});
