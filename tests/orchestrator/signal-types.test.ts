import { PerformanceWriter } from '@gossip/orchestrator';
import { readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// L2: sanctioned internal accessor for tests (Step 5 exemption).
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

describe('PerformanceWriter — PerformanceSignal support', () => {
  const testDir = join(tmpdir(), 'gossip-signal-types-' + Date.now());
  const filePath = join(testDir, '.gossip', 'agent-performance.jsonl');
  let writer: PerformanceWriter;

  beforeAll(() => {
    mkdirSync(join(testDir, '.gossip'), { recursive: true });
    writer = new PerformanceWriter(testDir);
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  test('writes ImplSignal to JSONL', () => {
    writer[WRITER_INTERNAL].appendSignal({
      type: 'impl',
      signal: 'impl_test_pass',
      agentId: 'agent-a',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
    });
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.type).toBe('impl');
    expect(last.signal).toBe('impl_test_pass');
  });

  test('writes MetaSignal to JSONL', () => {
    writer[WRITER_INTERNAL].appendSignal({
      type: 'meta',
      signal: 'task_completed',
      agentId: 'agent-a',
      taskId: 'task-1',
      value: 5200,
      timestamp: new Date().toISOString(),
    });
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.type).toBe('meta');
    expect(last.value).toBe(5200);
  });

  test('appendSignals accepts mixed PerformanceSignal array', () => {
    writer[WRITER_INTERNAL].appendSignals([
      { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'a', evidence: 'ok', timestamp: new Date().toISOString() },
      { type: 'impl', signal: 'impl_test_fail', agentId: 'b', taskId: 't2', timestamp: new Date().toISOString() },
    ]);
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  test('writes ConsensusSignal with category field', () => {
    writer[WRITER_INTERNAL].appendSignal({
      type: 'consensus',
      taskId: 't3',
      signal: 'category_confirmed',
      agentId: 'agent-a',
      category: 'injection_vectors',
      evidence: 'test',
      timestamp: new Date().toISOString(),
    });
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.signal).toBe('category_confirmed');
    expect(last.category).toBe('injection_vectors');
  });
});
